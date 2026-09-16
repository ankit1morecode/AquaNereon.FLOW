import { describe, expect, it } from 'vitest';
import { deriveFieldParams } from '../src/viz/core/fieldParams';
import { analyseRing, sampleRing, CHANNEL_COUNT } from '../src/viz/core/sensorRing';
import {
  buildSignature,
  captureBaseline,
  scoreFrame,
  PERSISTENCE_TAU,
} from '../src/viz/core/baseline';
import {
  BASELINE_CONDITION,
  findScenario,
  ManualFlowSource,
  SCENARIOS,
  SyntheticFlowSource,
} from '../src/viz/data/SyntheticFlowSource';
import type { FlowState } from '../src/viz/core/types';

/**
 * End-to-end tests for the bundled scenarios.
 *
 * The software dossier is explicit that a demonstration must not claim a
 * detection merely because the scenario was wired to produce one. These run
 * each dataset through the real chain — condition, field, ring, baseline,
 * state machine — and assert on what comes out the far end, so the claim in
 * the README is checked rather than asserted.
 */

const baseline = captureBaseline('balanced-12-12', BASELINE_CONDITION);
const channels = new Float32Array(CHANNEL_COUNT);

interface RunResult {
  states: Set<FlowState>;
  finalState: FlowState;
  peakDistance: number;
  peakDeficit: number;
  peakAsymmetry: number;
  distances: number[];
}

/** Replay a scenario at display rate through the whole measurement chain. */
function run(id: string, loops = 1): RunResult {
  const source = new SyntheticFlowSource(findScenario(id));
  const dt = 1 / 30;
  const steps = Math.round((source.durationSec * loops) / dt);

  let state: FlowState = 'STABLE';
  let persisted = 0;
  const states = new Set<FlowState>();
  const distances: number[] = [];
  let peakDistance = 0;
  let peakDeficit = 0;
  let peakAsymmetry = 0;

  for (let i = 0; i <= steps; i++) {
    const t = i * dt;
    const cond = source.sample(t);
    const F = deriveFieldParams(cond, t);
    sampleRing(F, cond.noiseLevel, channels);
    const frame = analyseRing(channels);

    const instant = scoreFrame(frame, baseline);
    persisted += (instant - persisted) * (1 - Math.exp(-dt / PERSISTENCE_TAU));

    const sig = buildSignature(frame, F.swirlNumber, persisted, state);
    state = sig.state;
    states.add(state);
    distances.push(persisted);
    peakDistance = Math.max(peakDistance, persisted);
    peakDeficit = Math.max(peakDeficit, F.axialDeficit);
    peakAsymmetry = Math.max(peakAsymmetry, frame.asymmetry);
  }

  return { states, finalState: state, peakDistance, peakDeficit, peakAsymmetry, distances };
}

describe('scenario datasets', () => {
  it('bundles exactly the three the brief calls for', () => {
    expect(SCENARIOS.map((s) => s.id)).toEqual(['NORMAL', 'DRIFT', 'DISTURBANCE']);
  });

  it('has monotonically increasing keyframe times and a matching loop length', () => {
    for (const s of SCENARIOS) {
      for (let i = 1; i < s.keyframes.length; i++) {
        expect(s.keyframes[i].t).toBeGreaterThan(s.keyframes[i - 1].t);
      }
      expect(s.keyframes[0].t).toBe(0);
      expect(s.keyframes[s.keyframes.length - 1].t).toBe(s.loopSec);
    }
  });

  it('loops seamlessly: the last keyframe matches the first', () => {
    for (const s of SCENARIOS) {
      const first = s.keyframes[0];
      const last = s.keyframes[s.keyframes.length - 1];
      expect(last.a).toBeCloseTo(first.a, 6);
      expect(last.b).toBeCloseTo(first.b, 6);
    }
  });

  it('keeps every flow rate physically plausible', () => {
    for (const s of SCENARIOS) {
      for (const k of s.keyframes) {
        expect(k.a).toBeGreaterThanOrEqual(0);
        expect(k.b).toBeGreaterThanOrEqual(0);
        expect(k.a + k.b).toBeLessThan(60);
        expect(k.restriction).toBeGreaterThanOrEqual(0);
        expect(k.restriction).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('NORMAL', () => {
  const result = run('NORMAL');

  it('never leaves STABLE', () => {
    expect([...result.states]).toEqual(['STABLE']);
  });

  it('stays well clear of the drift threshold', () => {
    expect(result.peakDistance).toBeLessThan(0.02);
  });

  it('never approaches recirculation', () => {
    expect(result.peakDeficit).toBeLessThan(0.5);
  });
});

describe('FLOW DRIFT', () => {
  const result = run('DRIFT');

  it('reaches DRIFT', () => {
    expect(result.states.has('DRIFT')).toBe(true);
  });

  it('stops short of a disturbance', () => {
    expect(result.states.has('DISTURBANCE')).toBe(false);
    expect(result.peakDeficit).toBeLessThan(1);
  });

  it('develops measurable circumferential asymmetry', () => {
    expect(result.peakAsymmetry).toBeGreaterThan(0.02);
  });

  it('develops the deviation gradually rather than stepping into it', () => {
    // Drift is defined by being slow. The largest single-sample jump should be
    // a small fraction of the total excursion, or this is a step change
    // wearing a drift label.
    let maxJump = 0;
    for (let i = 1; i < result.distances.length; i++) {
      maxJump = Math.max(maxJump, Math.abs(result.distances[i] - result.distances[i - 1]));
    }
    expect(maxJump).toBeLessThan(result.peakDistance * 0.1);
  });

  it('recovers to STABLE when the branches rebalance at the end of the loop', () => {
    expect(result.finalState).toBe('STABLE');
  });
});

describe('DISTURBANCE', () => {
  const result = run('DISTURBANCE');

  it('reaches DISTURBANCE', () => {
    expect(result.states.has('DISTURBANCE')).toBe(true);
  });

  it('passes through the intermediate states on the way', () => {
    expect(result.states.has('DRIFT')).toBe(true);
    expect(result.states.has('PRE_DISTURBANCE')).toBe(true);
  });

  it('opens a recirculation bubble', () => {
    expect(result.peakDeficit).toBeGreaterThan(1);
  });

  it('disturbs the ring pattern far more than drift does', () => {
    expect(result.peakDistance).toBeGreaterThan(run('DRIFT').peakDistance * 2);
  });
});

describe('scenario separation', () => {
  it('orders the three by how far each moves the ring from baseline', () => {
    const normal = run('NORMAL').peakDistance;
    const drift = run('DRIFT').peakDistance;
    const disturbance = run('DISTURBANCE').peakDistance;
    expect(normal).toBeLessThan(drift);
    expect(drift).toBeLessThan(disturbance);
  });
});

describe('synthetic source', () => {
  it('interpolates smoothly between keyframes', () => {
    const source = new SyntheticFlowSource(findScenario('DRIFT'));
    let maxJump = 0;
    let previous = source.sample(0).inletB.flowLps;
    for (let t = 0.01; t < source.durationSec; t += 0.01) {
      const now = source.sample(t).inletB.flowLps;
      maxJump = Math.max(maxJump, Math.abs(now - previous));
      previous = now;
    }
    expect(maxJump).toBeLessThan(0.05);
  });

  it('loops', () => {
    const source = new SyntheticFlowSource(findScenario('NORMAL'));
    const a = source.sample(2);
    const b = source.sample(2 + source.durationSec);
    expect(b.inletA.flowLps).toBeCloseTo(a.inletA.flowLps, 6);
  });

  it('handles negative time without producing NaN', () => {
    const source = new SyntheticFlowSource(findScenario('NORMAL'));
    const c = source.sample(-5);
    expect(Number.isFinite(c.inletA.flowLps)).toBe(true);
    expect(c.inletA.flowLps).toBeGreaterThan(0);
  });

  it('falls back to the first scenario for an unknown id', () => {
    expect(findScenario('NOPE').id).toBe('NORMAL');
  });
});

describe('manual source', () => {
  it('reports whatever the sliders are set to', () => {
    const source = new ManualFlowSource();
    source.flowA = 19;
    source.flowB = 3;
    source.restriction = 0.4;
    const c = source.sample(7);
    expect(c.inletA.flowLps).toBe(19);
    expect(c.inletB.flowLps).toBe(3);
    expect(c.downstreamRestriction).toBe(0.4);
    expect(c.t).toBe(7);
  });

  it('is open-ended, so the transport shows no timeline', () => {
    expect(new ManualFlowSource().durationSec).toBeNull();
  });
});
