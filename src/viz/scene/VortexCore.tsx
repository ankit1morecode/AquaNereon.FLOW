import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { CHAMBER_IN_X, GEO, OUTLET_END_X } from '../config/geometry';
import { coreCenterAt } from '../core/flowField';
import type { SimulationEngine } from '../sim/SimulationEngine';

/**
 * The vortex structure, drawn in two layers.
 *
 *   - A bright filament along the core line itself. This is what shows the
 *     vortex moving off axis and precessing — the single fact the whole
 *     sensing concept rests on, and the one thing a cloud of tracer particles
 *     cannot make legible on its own.
 *   - A translucent envelope at the radius where the Lamb-Oseen tangential
 *     velocity peaks, banded helically so the rotation of the column reads
 *     even when the core is nearly straight.
 *
 * Both are interpretations rather than direct traces: real hardware never sees
 * the core, it infers it. They are drawn because the argument being made is
 * that the core's position is what the sensor ring measures, and that argument
 * is not visible without them.
 *
 * Topology is built once; only positions are rewritten each frame, so a core
 * precessing at several hertz costs no allocations.
 */

const AXIAL_SEGMENTS = 90;
const RADIAL_SEGMENTS = 14;
const X_START = CHAMBER_IN_X + 0.1;
const X_END = OUTLET_END_X - 0.6;
const VERT_COUNT = (AXIAL_SEGMENTS + 1) * (RADIAL_SEGMENTS + 1);

function buildTubeGeometry(): THREE.BufferGeometry {
  const positions = new Float32Array(VERT_COUNT * 3);
  const normals = new Float32Array(VERT_COUNT * 3);
  const uvs = new Float32Array(VERT_COUNT * 2);
  const indices: number[] = [];

  for (let i = 0; i <= AXIAL_SEGMENTS; i++) {
    for (let j = 0; j <= RADIAL_SEGMENTS; j++) {
      const k = i * (RADIAL_SEGMENTS + 1) + j;
      uvs[k * 2] = i / AXIAL_SEGMENTS;
      uvs[k * 2 + 1] = j / RADIAL_SEGMENTS;
    }
  }
  for (let i = 0; i < AXIAL_SEGMENTS; i++) {
    for (let j = 0; j < RADIAL_SEGMENTS; j++) {
      const a = i * (RADIAL_SEGMENTS + 1) + j;
      const b = a + RADIAL_SEGMENTS + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(4, 0, 0), 20);
  g.computeBoundingSphere = () => {};
  return g;
}

const SHARED_VERTEX = /* glsl */ `
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
`;

/** Bright, nearly solid filament tracing the core line. */
function createFilamentMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uStrength: { value: 0 },
      uBreakdown: { value: 0 },
      uColor: { value: new THREE.Color('#d8f6ff') },
      uHot: { value: new THREE.Color('#ff7d92') },
    },
    vertexShader: SHARED_VERTEX,
    fragmentShader: /* glsl */ `
      uniform float uStrength;
      uniform float uBreakdown;
      uniform vec3 uColor;
      uniform vec3 uHot;
      varying vec2 vUv;
      varying vec3 vNormalW;
      varying vec3 vViewDir;

      void main() {
        // Face-on the filament is brightest; the rim falls away so it reads as
        // a rounded cord rather than a flat ribbon.
        float facing = abs(dot(normalize(vNormalW), normalize(vViewDir)));
        float body = 0.35 + 0.65 * facing;

        // Present only where a coherent core exists: it forms in the chamber
        // and is worn away downstream.
        float ends = smoothstep(0.0, 0.1, vUv.x) * (1.0 - smoothstep(0.55, 0.92, vUv.x));

        vec3 col = mix(uColor, uHot, uBreakdown);
        gl_FragColor = vec4(col, body * ends * uStrength);
      }
    `,
  });
}

/** Faint rotating shell at the peak-tangential-velocity radius. */
function createEnvelopeMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uStrength: { value: 0 },
      uBreakdown: { value: 0 },
      uColor: { value: new THREE.Color('#6fdcff') },
      uHot: { value: new THREE.Color('#ff5f7a') },
    },
    vertexShader: SHARED_VERTEX,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uStrength;
      uniform float uBreakdown;
      uniform vec3 uColor;
      uniform vec3 uHot;
      varying vec2 vUv;
      varying vec3 vNormalW;
      varying vec3 vViewDir;

      void main() {
        float facing = abs(dot(normalize(vNormalW), normalize(vViewDir)));
        float shell = pow(1.0 - facing, 1.8);

        // Helical banding advected along the column: this is what turns the
        // shell from a tube into something visibly spinning.
        float helix = sin(vUv.y * 6.2831 * 2.0 - vUv.x * 30.0 + uTime * 6.0);
        helix = smoothstep(0.0, 0.9, helix);

        float ends = smoothstep(0.0, 0.14, vUv.x) * (1.0 - smoothstep(0.5, 0.95, vUv.x));

        vec3 col = mix(uColor, uHot, uBreakdown);
        float a = (shell * 0.34 + helix * 0.14) * ends * uStrength;
        gl_FragColor = vec4(col * (0.6 + 0.9 * helix), a);
      }
    `,
  });
}

export function VortexCore({ engine }: { engine: SimulationEngine }) {
  const filamentRef = useRef<THREE.Mesh>(null);
  const envelopeRef = useRef<THREE.Mesh>(null);
  const core = useMemo(() => ({ y: 0, z: 0 }), []);

  const filamentGeometry = useMemo(buildTubeGeometry, []);
  const envelopeGeometry = useMemo(buildTubeGeometry, []);
  const filamentMaterial = useMemo(createFilamentMaterial, []);
  const envelopeMaterial = useMemo(createEnvelopeMaterial, []);

  useEffect(
    () => () => {
      filamentGeometry.dispose();
      envelopeGeometry.dispose();
      filamentMaterial.dispose();
      envelopeMaterial.dispose();
    },
    [filamentGeometry, envelopeGeometry, filamentMaterial, envelopeMaterial],
  );

  useFrame(() => {
    const filament = filamentRef.current;
    const envelope = envelopeRef.current;
    if (!filament || !envelope) return;
    const F = engine.field;

    // A visible core needs both rotation and coherence; with almost no
    // circulation there is nothing honest to draw.
    const strength = Math.min(1, F.swirlNumber * 1.6) * Math.min(1, F.uOut * 0.4);
    const breakdown = Math.min(1, Math.max(0, F.axialDeficit - 0.55) / 1.1);

    filamentMaterial.uniforms.uStrength.value = strength;
    filamentMaterial.uniforms.uBreakdown.value = breakdown;
    envelopeMaterial.uniforms.uStrength.value = strength;
    envelopeMaterial.uniforms.uBreakdown.value = breakdown;
    envelopeMaterial.uniforms.uTime.value = F.time;

    const fPos = filament.geometry.getAttribute('position') as THREE.BufferAttribute;
    const fNrm = filament.geometry.getAttribute('normal') as THREE.BufferAttribute;
    const ePos = envelope.geometry.getAttribute('position') as THREE.BufferAttribute;
    const eNrm = envelope.geometry.getAttribute('normal') as THREE.BufferAttribute;
    const fp = fPos.array as Float32Array;
    const fn = fNrm.array as Float32Array;
    const ep = ePos.array as Float32Array;
    const en = eNrm.array as Float32Array;

    // The envelope sits where a Lamb-Oseen vortex reaches its peak tangential
    // velocity, r = 1.1209 * rc, rather than at an arbitrary thickness. The
    // filament thickens a little once the core breaks down and loses its
    // definition.
    const envelopeR = F.coreRadius * 1.1209;
    const filamentR = GEO.pipeRadius * (0.055 + 0.05 * breakdown);

    for (let i = 0; i <= AXIAL_SEGMENTS; i++) {
      const x = X_START + ((X_END - X_START) * i) / AXIAL_SEGMENTS;
      coreCenterAt(x, F, core);

      // Both taper as the circulation decays downstream.
      const decay = 1 - 0.35 * Math.min(1, Math.max(0, (x - GEO.sensorRingX) / 6));
      const rE = envelopeR * decay;
      const rF = filamentR * decay;

      for (let j = 0; j <= RADIAL_SEGMENTS; j++) {
        const a = (j / RADIAL_SEGMENTS) * Math.PI * 2;
        const cy = Math.cos(a);
        const cz = Math.sin(a);
        const k = (i * (RADIAL_SEGMENTS + 1) + j) * 3;

        fp[k] = x;
        fp[k + 1] = core.y + cy * rF;
        fp[k + 2] = core.z + cz * rF;
        ep[k] = x;
        ep[k + 1] = core.y + cy * rE;
        ep[k + 2] = core.z + cz * rE;

        fn[k] = en[k] = 0;
        fn[k + 1] = en[k + 1] = cy;
        fn[k + 2] = en[k + 2] = cz;
      }
    }

    fPos.needsUpdate = true;
    fNrm.needsUpdate = true;
    ePos.needsUpdate = true;
    eNrm.needsUpdate = true;
    filament.visible = envelope.visible = strength > 0.02;
  });

  return (
    <group>
      <mesh
        ref={envelopeRef}
        geometry={envelopeGeometry}
        material={envelopeMaterial}
        renderOrder={13}
        frustumCulled={false}
      />
      <mesh
        ref={filamentRef}
        geometry={filamentGeometry}
        material={filamentMaterial}
        renderOrder={15}
        frustumCulled={false}
      />
    </group>
  );
}
