import { deriveFieldParams } from './fieldParams';
import { analyseRing, distributionDistance, sampleRing, CHANNEL_COUNT } from './sensorRing';
import type { CircumferentialFrame, FlowSignature, FlowState, JunctionCondition } from './types';

/**
 * Baseline and state classification.
 *
 * The baseline is a stored distribution vector, not a hard-coded threshold on
 * a raw reading. It is computed by running a known-normal operating condition
 * through the same sensor model the live path uses, then averaging over a
 * window long enough to cover several precession cycles. Swapping to real
 * hardware means recording that window from the real ring instead; nothing
 * about the comparison changes.
 */

export interface Baseline {
  id: string;
  distribution: Float32Array;
  /** Per-channel standard deviation over the capture window. */
  spread: Float32Array;
  swirlNumber: number;
  asymmetry: number;
  sectorImbalance: number;
  capturedFrom: JunctionCondition;
}

/** Number of samples in a baseline capture, and the span they cover. */
const CAPTURE_SAMPLES = 96;
const CAPTURE_SPAN_SEC = 12;

/**
 * Build a baseline by replaying a steady condition through the sensor model.
 * Deterministic: the same condition always yields the same baseline.
 */
export function captureBaseline(id: string, cond: JunctionCondition): Baseline {
  const acc = new Float64Array(CHANNEL_COUNT);
  const accSq = new Float64Array(CHANNEL_COUNT);
  const channels = new Float32Array(CHANNEL_COUNT);
  let swirl = 0;
  let asym = 0;
  let imbalance = 0;

  for (let s = 0; s < CAPTURE_SAMPLES; s++) {
    const t = (s / CAPTURE_SAMPLES) * CAPTURE_SPAN_SEC;
    const F = deriveFieldParams({ ...cond, t }, t);
    sampleRing(F, 0, channels);
    const frame = analyseRing(channels);
    for (let i = 0; i < CHANNEL_COUNT; i++) {
      acc[i] += frame.distribution[i];
      accSq[i] += frame.distribution[i] ** 2;
    }
    swirl += F.swirlNumber;
    asym += frame.asymmetry;
    imbalance += frame.sectorImbalance;
  }

  const distribution = new Float32Array(CHANNEL_COUNT);
  const spread = new Float32Array(CHANNEL_COUNT);
  for (let i = 0; i < CHANNEL_COUNT; i++) {
    const m = acc[i] / CAPTURE_SAMPLES;
    distribution[i] = m;
    spread[i] = Math.sqrt(Math.max(0, accSq[i] / CAPTURE_SAMPLES - m * m));
  }

  return {
    id,
    distribution,
    spread,
    swirlNumber: swirl / CAPTURE_SAMPLES,
    asymmetry: asym / CAPTURE_SAMPLES,
    sectorImbalance: imbalance / CAPTURE_SAMPLES,
    capturedFrom: cond,
  };
}

/* ------------------------------------------------------------------ */
/* Four-state machine                                                  */
/* ------------------------------------------------------------------ */

/**
 * Classifier thresholds on normalised baseline distance. These are the one
 * genuinely tuned set of numbers in the pipeline: the distance itself is
 * measured, but where the boundaries sit between "developing" and "abnormal"
 * is a policy choice that real deployment data would set.
 */
export const STATE_THRESHOLDS = {
  drift: 0.035,
  preDisturbance: 0.085,
  disturbance: 0.17,
} as const;

export function classify(distance: number): FlowState {
  if (distance < STATE_THRESHOLDS.drift) return 'STABLE';
  if (distance < STATE_THRESHOLDS.preDisturbance) return 'DRIFT';
  if (distance < STATE_THRESHOLDS.disturbance) return 'PRE_DISTURBANCE';
  return 'DISTURBANCE';
}

/**
 * Hysteresis so the badge does not flicker on the boundary. A state must be
 * exceeded by a margin before it is entered, and fall back below by the same
 * margin before it is left.
 */
export function applyHysteresis(
  previous: FlowState,
  candidate: FlowState,
  distance: number,
): FlowState {
  const order: FlowState[] = ['STABLE', 'DRIFT', 'PRE_DISTURBANCE', 'DISTURBANCE'];
  const prevIdx = order.indexOf(previous);
  const nextIdx = order.indexOf(candidate);
  if (nextIdx === prevIdx) return previous;

  const edges = [
    STATE_THRESHOLDS.drift,
    STATE_THRESHOLDS.preDisturbance,
    STATE_THRESHOLDS.disturbance,
  ];
  const margin = 0.15; // 15% of the edge value

  if (nextIdx > prevIdx) {
    const edge = edges[prevIdx];
    return distance > edge * (1 + margin) ? candidate : previous;
  }
  const edge = edges[nextIdx];
  return distance < edge * (1 - margin) ? candidate : previous;
}

/** Instantaneous deviation of a circumferential frame from its baseline. */
export function scoreFrame(frame: CircumferentialFrame, baseline: Baseline): number {
  return distributionDistance(frame.distribution, baseline.distribution);
}

/**
 * Assemble a signature from an already-persisted deviation.
 *
 * The distance passed in should be time-filtered rather than instantaneous:
 * a precessing core sweeps past every channel several times a second, so an
 * unfiltered reading swings across two state boundaries per revolution and
 * says nothing about whether the flow has actually changed. Persistence is
 * part of the measurement, not a cosmetic smoothing of it.
 */
export function buildSignature(
  frame: CircumferentialFrame,
  swirlNumber: number,
  persistedDistance: number,
  previousState: FlowState,
): FlowSignature {
  const state = applyHysteresis(
    previousState,
    classify(persistedDistance),
    persistedDistance,
  );
  return { ...frame, swirlNumber, baselineDistance: persistedDistance, state };
}

/** Time constant of the persistence filter, seconds. */
export const PERSISTENCE_TAU = 1.1;
