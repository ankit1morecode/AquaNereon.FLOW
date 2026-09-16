import { GEO } from '../config/geometry';
import { sampleVelocity } from './flowField';
import { hash01, type Vec3 } from './math';
import type { CircumferentialFrame, FieldParams } from './types';

/**
 * The circumferential sensor ring.
 *
 * A ring of N elements mounted around the outlet pipe, each responding to the
 * near-wall momentum passing through its own angular sector. The ring never
 * sees the vortex directly; it only sees how the vortex has redistributed
 * momentum around the circumference. That redistribution is the flow
 * fingerprint, and recovering it here is the whole point of the assembly.
 *
 * Deliberately kept as a plain function of the velocity field so that swapping
 * in real channel readings later means replacing `sampleRing` with a reader
 * and leaving every downstream feature calculation untouched.
 */

const N = GEO.sensorChannels;

/** Radii within the bore that each element integrates over, as a fraction of R. */
const SAMPLE_RADII = [0.58, 0.76, 0.91];
/** Half-width of an element's angular acceptance, radians. */
const SECTOR_HALF_WIDTH = 0.085;

/** Weight of tangential (swirl) momentum in an element's response. */
const TANGENTIAL_SENSITIVITY = 0.55;

const tmpV: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Read the ring at the current instant by sampling the flow field inside each
 * element's acceptance cone.
 */
export function sampleRing(
  F: FieldParams,
  noiseLevel: number,
  out: Float32Array,
): void {
  const R = GEO.pipeRadius;
  const x = GEO.sensorRingX;

  for (let i = 0; i < N; i++) {
    const phi = (i / N) * Math.PI * 2;
    let acc = 0;
    let n = 0;

    for (let ri = 0; ri < SAMPLE_RADII.length; ri++) {
      const r = R * SAMPLE_RADII[ri];
      for (let a = -1; a <= 1; a += 2) {
        const ang = phi + a * SECTOR_HALF_WIDTH;
        const py = r * Math.cos(ang);
        const pz = r * Math.sin(ang);
        sampleVelocity(tmpV, x, py, pz, F, -1);

        // Axial momentum through the element...
        const axial = tmpV.x;
        // ...plus the tangential component sweeping past it. A real
        // circumferential element is sensitive to both; a purely axial
        // response would be blind to swirl direction.
        const invR = 1 / r;
        const tY = -pz * invR;
        const tZ = py * invR;
        const tangential = tmpV.y * tY + tmpV.z * tZ;

        acc += axial + TANGENTIAL_SENSITIVITY * Math.abs(tangential);
        n++;
      }
    }

    let value = acc / n;

    // Per-element gain mismatch: fixed, deterministic, and exactly the kind of
    // bias a real ring has after assembly. Left in so that the baseline has to
    // absorb it rather than the model pretending it does not exist.
    value *= 0.97 + 0.06 * hash01(i * 7919 + 13);

    // Measurement noise, scaled by the reported noise level.
    if (noiseLevel > 0) {
      const t = F.time * 37.1 + i * 12.9898;
      const jitter = Math.sin(t) * 0.5 + Math.sin(t * 2.37 + 1.7) * 0.5;
      value *= 1 + jitter * 0.035 * noiseLevel;
    }

    out[i] = Math.max(value, 0);
  }
}

/** Reduce a raw channel vector to the dossier's circumferential feature group. */
export function analyseRing(channels: Float32Array): CircumferentialFrame {
  let sum = 0;
  let max = -Infinity;
  let min = Infinity;
  for (let i = 0; i < N; i++) {
    const c = channels[i];
    sum += c;
    if (c > max) max = c;
    if (c < min) min = c;
  }
  const mean = sum / N || 1e-9;

  let varAcc = 0;
  let gradAcc = 0;
  let vecY = 0;
  let vecZ = 0;
  const distribution = new Float32Array(N);

  for (let i = 0; i < N; i++) {
    const c = channels[i];
    distribution[i] = c / mean;
    varAcc += (c - mean) ** 2;
    gradAcc += Math.abs(channels[(i + 1) % N] - c);
    const phi = (i / N) * Math.PI * 2;
    vecY += c * Math.cos(phi);
    vecZ += c * Math.sin(phi);
  }

  // Asymmetry as the resultant of the channel vectors. Zero for a ring that
  // reads the same all the way round, regardless of how large the readings are.
  const asymmetry = Math.hypot(vecY, vecZ) / (sum || 1e-9);

  // Circumferential Fourier modes of the distribution. Mode 1 is a core that
  // has moved off axis, mode 2 an elliptic deformation, mode 3 a three-lobed
  // structure. These are the descriptors that make one fingerprint
  // distinguishable from another.
  const modes: [number, number, number] = [0, 0, 0];
  let mode1Phase = 0;
  for (let m = 1; m <= 3; m++) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < N; i++) {
      const ang = (2 * Math.PI * m * i) / N;
      re += distribution[i] * Math.cos(ang);
      im += distribution[i] * Math.sin(ang);
    }
    re /= N;
    im /= N;
    modes[m - 1] = 2 * Math.hypot(re, im);
    if (m === 1) mode1Phase = Math.atan2(im, re);
  }

  return {
    channels,
    distribution,
    mean,
    variance: varAcc / N,
    maxMinusMin: max - min,
    asymmetry,
    sectorImbalance: (max - min) / mean,
    spatialGradient: gradAcc / N,
    modes,
    mode1Phase,
  };
}

/**
 * L2 distance between two distribution vectors, normalised by channel count so
 * the number means the same thing for any ring size.
 */
export function distributionDistance(a: Float32Array, b: Float32Array): number {
  let acc = 0;
  for (let i = 0; i < a.length; i++) acc += (a[i] - b[i]) ** 2;
  return Math.sqrt(acc / a.length);
}

export const CHANNEL_COUNT = N;
