import * as THREE from 'three';

/**
 * Tracer particle material.
 *
 * Each particle is drawn as a short streak aligned with its own velocity and
 * as long as the distance it covers in a fixed slice of time — the same thing
 * a camera with a finite shutter would record of illuminated dye. That one
 * choice does most of the work of making the flow look physical:
 *
 *   - Speed becomes directly readable as streak length, so the acceleration
 *     through the contraction and the stall on a broken-down core are visible
 *     rather than inferred.
 *   - Fast regions are necessarily sparse in tracer count, because the same
 *     number of particles per second is spread over more distance. Longer
 *     streaks compensate exactly, so the outlet does not look starved next to
 *     the slow chamber.
 *
 * Colour carries the branch the particle came from, so the mixing downstream
 * is legible without a single arrow.
 *
 * The geometry is still a point sprite: the vertex shader projects the streak
 * into screen space, sizes the sprite to contain it and hands the fragment
 * shader a direction, which shades a capsule inside the square.
 */

export const INLET_A_COLOR = new THREE.Color('#2fd8ff');
export const INLET_B_COLOR = new THREE.Color('#ff9a4d');

/** Effective shutter time, seconds of motion drawn into each streak. */
const STREAK_SECONDS = 0.055;

export function createParticleMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uColorA: { value: INLET_A_COLOR.clone() },
      uColorB: { value: INLET_B_COLOR.clone() },
      uHeadSize: { value: 11.0 },
      uStreak: { value: STREAK_SECONDS },
      uOpacity: { value: 0.2 },
      uPixelRatio: { value: 1 },
      uResolution: { value: new THREE.Vector2(1, 1) },
    },
    vertexShader: /* glsl */ `
      attribute float aSpeed;
      attribute float aOrigin;
      attribute float aAlpha;
      attribute vec3 aVelocity;

      uniform float uHeadSize;
      uniform float uStreak;
      uniform float uPixelRatio;
      uniform vec2 uResolution;

      varying float vSpeed;
      varying float vOrigin;
      varying float vAlpha;
      varying vec2 vDir;
      varying float vHalf;
      varying float vThick;
      varying float vNear;

      void main() {
        vSpeed = aSpeed;
        vOrigin = aOrigin;
        vAlpha = aAlpha;

        vec3 tail = position - aVelocity * uStreak;

        vec4 pHead = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        vec4 pTail = projectionMatrix * modelViewMatrix * vec4(tail, 1.0);

        // Centre the sprite on the middle of the streak so it covers both ends.
        // Keep the view-space position as well: depth has to be measured there,
        // not in clip space, where z has already been warped by the projection.
        vec4 mvMid = modelViewMatrix * vec4(position - aVelocity * uStreak * 0.5, 1.0);
        vec4 pMid = projectionMatrix * mvMid;
        gl_Position = pMid;

        // Streak length in device pixels.
        vec2 nHead = pHead.xy / max(pHead.w, 1e-4);
        vec2 nTail = pTail.xy / max(pTail.w, 1e-4);
        vec2 dpix = (nHead - nTail) * 0.5 * uResolution;
        float len = length(dpix);
        vDir = len > 1e-4 ? dpix / len : vec2(1.0, 0.0);

        // Head diameter, attenuated with distance, with a floor so distant
        // tracers stay visible instead of dissolving into sub-pixel noise.
        float dist = max(-mvMid.z, 0.001);
        float head = clamp(uHeadSize * uPixelRatio * (9.0 / dist), 1.0, 9.0);

        // Fade out anything sitting on the lens. The bore-scope view puts the
        // camera inside the water, and without this the nearest few tracers
        // become screen-filling smears that hide everything behind them.
        vNear = smoothstep(0.22, 1.3, dist);

        float box = head + len;
        gl_PointSize = clamp(box, 1.0, 72.0);

        // Normalised into the sprite's own -1..1 space.
        vHalf = len / max(box, 1e-4);
        vThick = head / max(box, 1e-4);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColorA;
      uniform vec3 uColorB;
      uniform float uOpacity;

      varying float vSpeed;
      varying float vOrigin;
      varying float vAlpha;
      varying vec2 vDir;
      varying float vHalf;
      varying float vThick;
      varying float vNear;

      void main() {
        // gl_PointCoord runs top-down; flip y so the direction matches the
        // screen-space vector the vertex shader computed.
        vec2 uv = (gl_PointCoord - 0.5) * 2.0;
        uv.y = -uv.y;

        float along = dot(uv, vDir);
        float across = dot(uv, vec2(-vDir.y, vDir.x));

        // Distance to the streak's centre line: a capsule, not a box, so the
        // ends stay round.
        float overshoot = max(abs(along) - vHalf, 0.0);
        float d = length(vec2(overshoot, across));

        float falloff = smoothstep(vThick, vThick * 0.15, d);
        if (falloff <= 0.0) discard;
        falloff *= falloff;

        vec3 base = mix(uColorA, uColorB, clamp(vOrigin, 0.0, 1.0));
        float s = clamp(vSpeed, 0.0, 1.8);

        // Stalled water goes deep and dim, fast water goes pale and bright.
        vec3 col = base * (0.5 + 0.55 * s);
        col = mix(col, vec3(1.0), smoothstep(1.1, 2.0, s) * 0.35);

        // Speed already shows as streak length; do not also pay for it in
        // brightness, or the fast outlet clips to white and the spiral inside
        // it stops being readable.
        float a = uOpacity * falloff * vAlpha * vNear * (0.62 + 0.28 * s);
        gl_FragColor = vec4(col, a);
      }
    `,
  });
}
