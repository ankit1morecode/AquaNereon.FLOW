import type {
  EvidenceItem,
  EventType,
  FlowSignature,
  FlowState,
  ModelOutput,
  NodeId,
  Severity,
} from '../types';

/**
 * What the platform currently believes about a node, and why.
 *
 * Extracted so there is exactly one definition of "the evidence supporting
 * this assessment". The simulator uses it to form events; Node Diagnostics
 * uses it to show the live assessment of a node that has not raised one. Two
 * separate implementations would drift, and the screen would end up explaining
 * a conclusion the event engine did not actually reach.
 *
 * Pure: no clock, no randomness, no I/O. That is what lets it be tested
 * directly and reused on both sides.
 */

export interface NeighbourState {
  node_id: NodeId;
  state: FlowState;
}

export interface AssessmentInput {
  signature: FlowSignature;
  state: FlowState;
  upstream: NeighbourState[];
  downstream: NeighbourState[];
}

export interface Assessment {
  evidence: EvidenceItem[];
  modelOutputs: ModelOutput[];
  /** True when upstream nodes show correlated behaviour. */
  propagated: boolean;
  /**
   * True when the pattern looks like loss rather than a passing disturbance:
   * one-sided, persistent, and with no upstream correlate to explain it.
   */
  leakSuspected: boolean;
  eventType: EventType;
  severity: Severity;
}

export const SEVERITY_ORDER: Severity[] = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
export const STATE_ORDER: FlowState[] = [
  'STABLE',
  'DRIFT',
  'PRE_DISTURBANCE',
  'DISTURBANCE',
];

export function severityForState(state: FlowState): Severity {
  switch (state) {
    case 'STABLE':
      return 'INFO';
    case 'DRIFT':
      return 'LOW';
    case 'PRE_DISTURBANCE':
      return 'MEDIUM';
    case 'DISTURBANCE':
      return 'HIGH';
  }
}

/**
 * Assemble the assessment from the signature that produced it.
 *
 * Dossier §16: nothing may report a conclusion without showing what changed,
 * where, how far from baseline, how fast, whether it persisted, what the
 * neighbours did, which models agreed and how good the data was. Every item
 * below is read off the live signature rather than asserted.
 */
export function assess({
  signature: sig,
  state,
  upstream,
  downstream,
}: AssessmentInput): Assessment {
  const propagated = upstream.some((n) => n.state !== 'STABLE');

  const evidence: EvidenceItem[] = [
    {
      kind: 'SIGNATURE_DEVIATION',
      label: 'Baseline distance',
      value: sig.baseline_distance.toFixed(3),
      weight: clamp01(sig.baseline_distance / 0.25),
      detail: `L2 distance of the 16-channel distribution from baseline ${sig.baseline_id}.`,
    },
    {
      kind: 'SENSOR',
      label: 'Circumferential asymmetry',
      value: sig.circumferential.asymmetry.toFixed(3),
      weight: clamp01(sig.circumferential.asymmetry / 0.12),
      detail: 'Resultant of the 16 channel vectors; zero for an even ring.',
    },
    {
      kind: 'SENSOR',
      label: 'Sector imbalance',
      value: sig.circumferential.sector_imbalance.toFixed(2),
      weight: clamp01(sig.circumferential.sector_imbalance / 1.2),
      detail: '(max - min) / mean across the ring.',
    },
    {
      kind: 'RATE_OF_CHANGE',
      label: 'Rate of change',
      value: `${(sig.temporal.rate_of_change * 1000).toFixed(1)} /ks`,
      weight: clamp01(Math.abs(sig.temporal.rate_of_change) * 40),
      detail: 'Change in baseline distance per second.',
    },
    {
      kind: 'PERSISTENCE',
      label: 'Persistence',
      value: `${Math.round(sig.temporal.persistence * 100)}%`,
      weight: clamp01(sig.temporal.persistence),
      detail: 'Fraction of the recent window at or above DRIFT.',
    },
    {
      kind: 'SENSOR',
      label: 'Core deficit',
      value: sig.hydraulic.axial_deficit.toFixed(2),
      weight: clamp01(sig.hydraulic.axial_deficit / 1.4),
      detail: 'Above 1.0 the vortex core recirculates.',
    },
    {
      kind: 'NEIGHBOUR',
      label: 'Upstream behaviour',
      value: propagated ? 'Disturbed' : 'Stable',
      weight: propagated ? 0.8 : 0.15,
      detail:
        upstream.map((n) => `${n.node_id}: ${n.state}`).join(', ') || 'No upstream nodes.',
    },
    {
      kind: 'DATA_QUALITY',
      label: 'Data quality',
      value: `${Math.round(sig.data_quality.confidence * 100)}%`,
      weight: clamp01(1 - sig.data_quality.confidence),
      detail: sig.data_quality.stale ? 'Feed is stale.' : 'Feed complete.',
    },
  ];

  const leakSuspected =
    state !== 'STABLE' &&
    state !== 'DRIFT' &&
    sig.circumferential.asymmetry > 0.05 &&
    sig.temporal.persistence > 0.5 &&
    !propagated;

  const eventType: EventType = leakSuspected
    ? 'LEAKAGE_SUSPECTED'
    : propagated
      ? 'NETWORK_EVENT'
      : 'FLOW_ANOMALY';

  const anomalyScore = clamp01(sig.baseline_distance / 0.28);

  const modelOutputs: ModelOutput[] = [
    {
      model_id: 'AI-01',
      model_version: '0.3.1',
      prediction: state,
      score: anomalyScore,
      confidence: sig.confidence,
      contributing_features: [
        'circumferential.asymmetry',
        'circumferential.modes[0]',
        'temporal.persistence',
        'hydraulic.axial_deficit',
      ],
      explanation: [
        state === 'STABLE'
          ? 'Circumferential distribution matches the stored baseline.'
          : 'Circumferential distribution departed from the stored baseline.',
        sig.temporal.persistence > 0.3
          ? 'Deviation persisted across consecutive windows rather than spiking.'
          : 'No sustained deviation across recent windows.',
        propagated
          ? 'Upstream nodes show correlated behaviour.'
          : 'No correlated upstream behaviour; any deviation appears local.',
      ],
    },
  ];

  if (leakSuspected) {
    modelOutputs.push({
      model_id: 'AI-03',
      model_version: '0.2.0',
      prediction: downstream.length
        ? `Suspected loss between this node and ${downstream[0].node_id}`
        : 'Suspected loss downstream of this node',
      score: clamp01(0.62 + sig.circumferential.asymmetry),
      confidence: 0.54,
      contributing_features: [
        'flow imbalance',
        'pressure deviation',
        'circumferential asymmetry',
        'acoustic RMS',
      ],
      explanation: [
        'Persistent one-sided circumferential pattern with no upstream correlate.',
        'Evidence is indicative, not conclusive: no metered consumption mismatch yet.',
      ],
    });
  }

  return {
    evidence,
    modelOutputs,
    propagated,
    leakSuspected,
    eventType,
    severity: severityForState(state),
  };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
