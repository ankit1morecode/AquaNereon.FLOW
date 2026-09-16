import { CHAMBER_IN_X, CHAMBER_OUT_X, GEO, OUTLET_END_X } from '../config/geometry';
import { smoothstep } from './math';

/**
 * Precomputed axial profile of the junction.
 *
 * A large part of the velocity field depends only on x: the bore radius and
 * its slope, how much of the inlet jets survive, how far the momentum lean has
 * decayed, where the vortex core has formed, how energetic the mixing is.
 * None of that changes when the flow rate changes, so it is tabulated once at
 * module load and interpolated in the inner loop.
 *
 * This is worth about a threefold saving on the per-particle cost, almost all
 * of it transcendental calls that were being repeated tens of thousands of
 * times a frame for an answer that never moved.
 *
 * The table is generated FROM the analytic functions below rather than from a
 * separate set of numbers, so the two cannot drift apart.
 */

const X_MIN = CHAMBER_IN_X - 1.5;
const X_MAX = OUTLET_END_X + 1.5;
const SAMPLES = 1024;
const STEP = (X_MAX - X_MIN) / (SAMPLES - 1);
const INV_STEP = 1 / STEP;

/* ---- analytic definitions (also used directly when building geometry) ---- */

/** Axial stations over which the chamber contracts into the outlet pipe. */
const CONTRACT_START = CHAMBER_OUT_X - 0.8;
const CONTRACT_END = CHAMBER_OUT_X + 0.35;
/** Rounded entry cap on the upstream face. */
const CAP_START = CHAMBER_IN_X - 0.05;
const CAP_END = CHAMBER_IN_X + 0.55;

/** Distance over which an inlet jet surrenders its identity to the column. */
const JET_DECAY = 1.55;

/**
 * Radius of the confining wall at axial station x.
 * Exported analytically because the chamber mesh is lathed from this curve —
 * the bore that is drawn and the bore the fluid solves inside are one surface.
 */
export function wallRadiusAt(x: number): number {
  const Rp = GEO.pipeRadius;
  const Rj = GEO.junctionRadius;
  const open = smoothstep(CAP_START, CAP_END, x);
  const close = smoothstep(CONTRACT_START, CONTRACT_END, x);
  const r = Rp * 1.35 + (Rj - Rp * 1.35) * open;
  return r + (Rp - r) * close;
}

function wallSlopeAnalytic(x: number): number {
  const h = 0.01;
  return (wallRadiusAt(x + h) - wallRadiusAt(x - h)) / (2 * h);
}

/**
 * How much of the momentum lean survives at station x. Fully developed through
 * the chamber, then slowly erased downstream as turbulent mixing evens the
 * profile out — which is precisely why the ring is mounted close to the
 * junction rather than far along the outlet.
 */
function leanDecayAnalytic(x: number): number {
  return Math.exp(-Math.max(0, x - CHAMBER_OUT_X) / 9);
}

/** Fraction of the chamber circulation present at station x. */
function circulationShapeAnalytic(x: number): number {
  const grow = smoothstep(CHAMBER_IN_X + 0.2, CHAMBER_OUT_X - 0.2, x);
  const decay = Math.exp(-Math.max(0, x - CHAMBER_OUT_X) / 14);
  return grow * decay;
}

/** Turbulence intensity mask: quiet pipes, energetic mixing zone, decaying wake. */
function turbulenceMaskAnalytic(x: number): number {
  const mixing = Math.exp(-(((x + 0.15) / 1.7) ** 2));
  const wake = 0.45 * Math.exp(-Math.max(0, x - CHAMBER_OUT_X) / 6);
  return 0.12 + 0.95 * mixing + wake;
}

/** Weight of the surviving inlet jets against the merged column. */
function jetWeightAnalytic(x: number): number {
  return Math.exp(-Math.max(0, x - CHAMBER_IN_X) / JET_DECAY);
}

/** How fully the vortex core has formed at station x. */
function coreGrowthAnalytic(x: number): number {
  return smoothstep(CHAMBER_IN_X + 0.3, CHAMBER_OUT_X + 0.6, x);
}

/** Downstream relaxation of the core back towards the axis. */
function coreRelaxAnalytic(x: number): number {
  return 1 - 0.35 * smoothstep(CHAMBER_OUT_X, CHAMBER_OUT_X + 7.5, x);
}

/* ---- table ---- */

const wallR = new Float32Array(SAMPLES);
const wallSlope = new Float32Array(SAMPLES);
/** 1 / (pi * R^2): the factor that turns volumetric flow into bulk speed. */
const invArea = new Float32Array(SAMPLES);
const leanDecay = new Float32Array(SAMPLES);
const circShape = new Float32Array(SAMPLES);
const turbMask = new Float32Array(SAMPLES);
const jetWeight = new Float32Array(SAMPLES);
const coreGrow = new Float32Array(SAMPLES);
const coreRelax = new Float32Array(SAMPLES);

for (let i = 0; i < SAMPLES; i++) {
  const x = X_MIN + i * STEP;
  const R = wallRadiusAt(x);
  wallR[i] = R;
  wallSlope[i] = wallSlopeAnalytic(x);
  invArea[i] = 1 / (Math.PI * R * R);
  leanDecay[i] = leanDecayAnalytic(x);
  circShape[i] = circulationShapeAnalytic(x);
  turbMask[i] = turbulenceMaskAnalytic(x);
  jetWeight[i] = jetWeightAnalytic(x);
  coreGrow[i] = coreGrowthAnalytic(x);
  coreRelax[i] = coreRelaxAnalytic(x);
}

/** Interpolated sample of every x-dependent quantity, filled in place. */
export interface AxialSample {
  wallR: number;
  wallSlope: number;
  invArea: number;
  leanDecay: number;
  circShape: number;
  turbMask: number;
  jetWeight: number;
  coreGrow: number;
  coreRelax: number;
}

export function makeAxialSample(): AxialSample {
  return {
    wallR: 0,
    wallSlope: 0,
    invArea: 0,
    leanDecay: 0,
    circShape: 0,
    turbMask: 0,
    jetWeight: 0,
    coreGrow: 0,
    coreRelax: 0,
  };
}

/** Fill `out` with the profile at x. Clamps at both ends of the table. */
export function sampleAxial(x: number, out: AxialSample): void {
  let f = (x - X_MIN) * INV_STEP;
  if (f <= 0) {
    f = 0;
  } else if (f >= SAMPLES - 1) {
    f = SAMPLES - 1.000001;
  }
  const i = f | 0;
  const t = f - i;
  const j = i + 1;

  out.wallR = wallR[i] + (wallR[j] - wallR[i]) * t;
  out.wallSlope = wallSlope[i] + (wallSlope[j] - wallSlope[i]) * t;
  out.invArea = invArea[i] + (invArea[j] - invArea[i]) * t;
  out.leanDecay = leanDecay[i] + (leanDecay[j] - leanDecay[i]) * t;
  out.circShape = circShape[i] + (circShape[j] - circShape[i]) * t;
  out.turbMask = turbMask[i] + (turbMask[j] - turbMask[i]) * t;
  out.jetWeight = jetWeight[i] + (jetWeight[j] - jetWeight[i]) * t;
  out.coreGrow = coreGrow[i] + (coreGrow[j] - coreGrow[i]) * t;
  out.coreRelax = coreRelax[i] + (coreRelax[j] - coreRelax[i]) * t;
}

/** Single-field lookups, for the few callers that need only one value. */
export function coreGrowthAt(x: number): number {
  let f = (x - X_MIN) * INV_STEP;
  if (f <= 0) f = 0;
  else if (f >= SAMPLES - 1) f = SAMPLES - 1.000001;
  const i = f | 0;
  const t = f - i;
  return coreGrow[i] + (coreGrow[i + 1] - coreGrow[i]) * t;
}

export function coreRelaxAt(x: number): number {
  let f = (x - X_MIN) * INV_STEP;
  if (f <= 0) f = 0;
  else if (f >= SAMPLES - 1) f = SAMPLES - 1.000001;
  const i = f | 0;
  const t = f - i;
  return coreRelax[i] + (coreRelax[i + 1] - coreRelax[i]) * t;
}
