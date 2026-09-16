import { clamp } from '../core/math';
import type { FlowDataSource, JunctionCondition } from '../core/types';
import normalJson from './scenarios/normal.json';
import driftJson from './scenarios/drift.json';
import disturbanceJson from './scenarios/disturbance.json';

/**
 * Replays a bundled keyframe dataset as a continuous junction condition.
 *
 * The datasets are deliberately small and human-readable: a handful of
 * timestamped branch flow rates and pressures. Everything the viewer sees —
 * the swirl, the core position, the ring pattern, the state badge — is
 * computed downstream of these numbers, so editing a flow rate in the JSON
 * changes the picture and nothing else has to be touched.
 */

export interface ScenarioKeyframe {
  /** Seconds from scenario start. */
  t: number;
  /** Branch A flow, L/s. */
  a: number;
  /** Branch B flow, L/s. */
  b: number;
  /** Branch A gauge pressure, kPa. */
  pA: number;
  /** Branch B gauge pressure, kPa. */
  pB: number;
  restriction: number;
  noise: number;
}

export interface ScenarioPulse {
  branch: 'A' | 'B';
  amplitudePct: number;
  hz: number;
}

export interface ScenarioDataset {
  id: string;
  label: string;
  caption: string;
  loopSec: number;
  keyframes: ScenarioKeyframe[];
  pulse?: ScenarioPulse;
}

export const SCENARIOS: ScenarioDataset[] = [
  normalJson as ScenarioDataset,
  driftJson as ScenarioDataset,
  disturbanceJson as ScenarioDataset,
];

export function findScenario(id: string): ScenarioDataset {
  return SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0];
}

/** Smooth interpolation between keyframes, so branch flow never steps. */
function smoothT(t: number): number {
  return t * t * (3 - 2 * t);
}

export class SyntheticFlowSource implements FlowDataSource {
  readonly id: string;
  readonly label: string;
  readonly durationSec: number;

  constructor(private readonly dataset: ScenarioDataset) {
    this.id = dataset.id;
    this.label = dataset.label;
    this.durationSec = dataset.loopSec;
  }

  get caption(): string {
    return this.dataset.caption;
  }

  sample(t: number): JunctionCondition {
    const { keyframes, loopSec, pulse } = this.dataset;
    const tt = loopSec > 0 ? ((t % loopSec) + loopSec) % loopSec : t;

    let i = 0;
    while (i < keyframes.length - 2 && keyframes[i + 1].t <= tt) i++;
    const k0 = keyframes[i];
    const k1 = keyframes[Math.min(i + 1, keyframes.length - 1)];
    const span = Math.max(k1.t - k0.t, 1e-6);
    const f = smoothT(clamp((tt - k0.t) / span, 0, 1));

    const mix = (x: number, y: number) => x + (y - x) * f;

    let a = mix(k0.a, k1.a);
    let b = mix(k0.b, k1.b);

    // Superimposed pulsation, the way a reciprocating pump or a chattering
    // valve would show up on a branch.
    if (pulse) {
      const osc = Math.sin(2 * Math.PI * pulse.hz * t);
      if (pulse.branch === 'A') a *= 1 + pulse.amplitudePct * osc;
      else b *= 1 + pulse.amplitudePct * osc;
    }

    return {
      t,
      inletA: {
        flowLps: Math.max(a, 0),
        pressureKpa: mix(k0.pA, k1.pA),
        temperatureC: 21.4,
      },
      inletB: {
        flowLps: Math.max(b, 0),
        pressureKpa: mix(k0.pB, k1.pB),
        temperatureC: 21.1,
      },
      downstreamRestriction: clamp(mix(k0.restriction, k1.restriction), 0, 1),
      noiseLevel: clamp(mix(k0.noise, k1.noise), 0, 1),
    };
  }
}

/**
 * Manual source: the viewer drives the branch flows directly with the sliders.
 * Same contract, so the scene cannot tell it apart from a replayed dataset.
 */
export class ManualFlowSource implements FlowDataSource {
  readonly id = 'MANUAL';
  readonly label = 'Manual';
  readonly durationSec = null;

  flowA = 12;
  flowB = 12;
  restriction = 0;
  noiseLevel = 0.12;

  sample(t: number): JunctionCondition {
    return {
      t,
      inletA: { flowLps: this.flowA, pressureKpa: 300 + this.flowA * 1.4, temperatureC: 21.4 },
      inletB: { flowLps: this.flowB, pressureKpa: 300 + this.flowB * 1.4, temperatureC: 21.1 },
      downstreamRestriction: this.restriction,
      noiseLevel: this.noiseLevel,
    };
  }
}

/** The steady condition the baseline is captured from. */
export const BASELINE_CONDITION: JunctionCondition = {
  t: 0,
  inletA: { flowLps: 12, pressureKpa: 312, temperatureC: 21.4 },
  inletB: { flowLps: 12, pressureKpa: 310, temperatureC: 21.1 },
  downstreamRestriction: 0,
  noiseLevel: 0,
};
