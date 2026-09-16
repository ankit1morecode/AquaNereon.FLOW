import * as THREE from 'three';

/**
 * Pipe glass.
 *
 * Deliberately not MeshPhysicalMaterial with transmission: real refraction
 * would bend and dim the water inside, which is the one thing that has to stay
 * readable. This is a Fresnel shell instead — nearly clear head-on, bright at
 * grazing angles — which reads as glass while leaving the interior untouched.
 *
 * Drawn in two passes, back faces before the water and front faces after, so
 * the shell genuinely wraps the particles rather than floating over them.
 */

export type GlassPass = 'back' | 'front';

export function createGlassMaterial(pass: GlassPass, tint = 0x5ad4e6): THREE.ShaderMaterial {
  const isBack = pass === 'back';

  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: isBack ? THREE.BackSide : THREE.FrontSide,
    blending: THREE.NormalBlending,
    uniforms: {
      uTint: { value: new THREE.Color(tint) },
      uRim: { value: new THREE.Color(0xa8f0ff) },
      uOpacity: { value: isBack ? 0.1 : 0.15 },
      uRimPower: { value: 2.4 },
      uRimStrength: { value: isBack ? 0.35 : 0.95 },
      uBandWidth: { value: 0.0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormalW;
      varying vec3 vViewDir;
      varying vec2 vUv;

      void main() {
        vUv = uv;
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vViewDir = normalize(cameraPosition - worldPos.xyz);
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uTint;
      uniform vec3 uRim;
      uniform float uOpacity;
      uniform float uRimPower;
      uniform float uRimStrength;

      varying vec3 vNormalW;
      varying vec3 vViewDir;
      varying vec2 vUv;

      void main() {
        vec3 n = normalize(vNormalW);
        float facing = abs(dot(n, normalize(vViewDir)));
        float fresnel = pow(1.0 - facing, uRimPower);

        vec3 col = mix(uTint, uRim, fresnel);
        float a = uOpacity + fresnel * uRimStrength;

        // Faint circumferential banding so the curvature of the bore is
        // readable even where there is no highlight to catch.
        float band = smoothstep(0.48, 0.5, abs(fract(vUv.x * 24.0) - 0.5));
        col += band * 0.06;

        gl_FragColor = vec4(col, clamp(a, 0.0, 0.95));
      }
    `,
  });
}

/** Brushed steel for flanges, collars and the sensor ring body. */
export function createMetalMaterial(color = 0x9aa7b4, rough = 0.42): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: rough,
    metalness: 0.85,
  });
}
