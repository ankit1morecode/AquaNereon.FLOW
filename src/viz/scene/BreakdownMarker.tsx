import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { CHAMBER_OUT_X, GEO } from '../config/geometry';
import { coreCenterAt } from '../core/flowField';
import type { SimulationEngine } from '../sim/SimulationEngine';

/**
 * Marks the recirculation bubble when the vortex core breaks down.
 *
 * Above an axial deficit of 1.0 the deficit exceeds the through-flow and the
 * water on the core is moving backwards. That is the single most important
 * thing that happens in the disturbance scenario and it is genuinely hard to
 * see, because a stalled tracer looks much like a slow one. This draws the
 * region where the axial velocity is actually negative, so the reversal reads
 * as a place rather than as a number on a panel.
 *
 * It is a marker, not a surface: it appears only when the model says the flow
 * has reversed, and its extent is the extent of that reversal.
 */

const SEGMENTS = 40;
const RINGS = 16;
const VERT_COUNT = (SEGMENTS + 1) * (RINGS + 1);

export function BreakdownMarker({ engine }: { engine: SimulationEngine }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const core = useMemo(() => ({ y: 0, z: 0 }), []);

  const geometry = useMemo(() => {
    const positions = new Float32Array(VERT_COUNT * 3);
    const normals = new Float32Array(VERT_COUNT * 3);
    const uvs = new Float32Array(VERT_COUNT * 2);
    const indices: number[] = [];
    for (let i = 0; i <= SEGMENTS; i++) {
      for (let j = 0; j <= RINGS; j++) {
        const k = i * (RINGS + 1) + j;
        uvs[k * 2] = i / SEGMENTS;
        uvs[k * 2 + 1] = j / RINGS;
      }
    }
    for (let i = 0; i < SEGMENTS; i++) {
      for (let j = 0; j < RINGS; j++) {
        const a = i * (RINGS + 1) + j;
        const b = a + RINGS + 1;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    g.setIndex(indices);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(3, 0, 0), 14);
    g.computeBoundingSphere = () => {};
    return g;
  }, []);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uTime: { value: 0 },
          uStrength: { value: 0 },
          uColor: { value: new THREE.Color('#ff4d6b') },
        },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          varying vec3 vNormalW;
          varying vec3 vViewDir;
          void main() {
            vUv = uv;
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vNormalW = normalize(mat3(modelMatrix) * normal);
            vViewDir = normalize(cameraPosition - wp.xyz);
            gl_Position = projectionMatrix * viewMatrix * wp;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform float uTime;
          uniform float uStrength;
          uniform vec3 uColor;
          varying vec2 vUv;
          varying vec3 vNormalW;
          varying vec3 vViewDir;

          void main() {
            float facing = abs(dot(normalize(vNormalW), normalize(vViewDir)));
            float shell = pow(1.0 - facing, 2.0);

            // Reverse-travelling bands: the water inside this region is going
            // the wrong way, and the markings say so by going the wrong way too.
            float bands = sin(vUv.x * 42.0 + uTime * 4.5);
            bands = smoothstep(0.25, 1.0, bands);

            // Soft caps so the bubble reads as a closed region, not a cut tube.
            float caps = smoothstep(0.0, 0.16, vUv.x) * (1.0 - smoothstep(0.84, 1.0, vUv.x));

            float a = (shell * 0.5 + bands * 0.22) * caps * uStrength;
            gl_FragColor = vec4(uColor, a);
          }
        `,
      }),
    [],
  );

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const F = engine.field;

    // Reversal needs the deficit to beat the renormalised through-flow. Below
    // that there is a slow core, not a recirculating one, and nothing to mark.
    const excess = F.axialDeficit - 1.0;
    if (excess <= 0.02) {
      mesh.visible = false;
      return;
    }
    mesh.visible = true;

    material.uniforms.uStrength.value = Math.min(1, excess / 0.45);
    material.uniforms.uTime.value = F.time;

    // The bubble spans the stations where the core deficit is established,
    // and its radius is where the Gaussian deficit falls to the through-flow.
    // ln(D) under the Gaussian gives the radius at which deficit == 1.
    const radius = F.coreRadius * Math.sqrt(Math.log(Math.max(F.axialDeficit, 1.001)));
    const xStart = CHAMBER_OUT_X - 0.35;
    const xEnd = Math.min(GEO.sensorRingX + 2.6, xStart + 2.0 + excess * 3.2);

    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const nrm = mesh.geometry.getAttribute('normal') as THREE.BufferAttribute;
    const pa = pos.array as Float32Array;
    const na = nrm.array as Float32Array;

    for (let i = 0; i <= SEGMENTS; i++) {
      const u = i / SEGMENTS;
      const x = xStart + (xEnd - xStart) * u;
      coreCenterAt(x, F, core);
      // Spindle profile: the bubble is fattest in the middle, closed at both ends.
      const r = radius * Math.sin(Math.PI * u) ** 0.65;

      for (let j = 0; j <= RINGS; j++) {
        const a = (j / RINGS) * Math.PI * 2;
        const cy = Math.cos(a);
        const cz = Math.sin(a);
        const k = (i * (RINGS + 1) + j) * 3;
        pa[k] = x;
        pa[k + 1] = core.y + cy * r;
        pa[k + 2] = core.z + cz * r;
        na[k] = 0;
        na[k + 1] = cy;
        na[k + 2] = cz;
      }
    }

    pos.needsUpdate = true;
    nrm.needsUpdate = true;
  });

  return (
    <mesh
      ref={meshRef}
      geometry={geometry}
      material={material}
      renderOrder={16}
      frustumCulled={false}
      visible={false}
    />
  );
}
