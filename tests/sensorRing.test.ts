import { describe, expect, it } from 'vitest';
import { deriveFieldParams } from '../src/viz/core/fieldParams';
import {
  analyseRing,
  distributionDistance,
  sampleRing,
  CHANNEL_COUNT,
} from '../src/viz/core/sensorRing';
import {
  applyHysteresis,
  captureBaseline,
  classify,
  scoreFrame,
  STATE_THRESHOLDS,
} from '../src/viz/core/baseline';
import { BASELINE_CONDITION } from '../src/viz/data/SyntheticFlowSource';
import type { FlowState, JunctionCondition } from '../src/viz/core/types';

/**
 * Tests for the measurement chain.
 *
 * This is where the visualization turns into an instrument, so these are the
 * tests that matter most: the ring must read evenly when the flow is even,
 * read unevenly when it is not, and the unevenness must land in the right
 * circumferential mode.
 */

function condition(a: number, b: number, restriction = 0, noise = 0): JunctionCondition {
  return {
    t: 0,
    inletA: { flowLps: a, pressureKpa: 300, temperatureC: 21 },
    inletB: { flowLps: b, pressureKpa: 300, temperatureC: 21 },
    downstreamRestriction: restriction,
    noiseLevel: noise,
  };
}

const channels = new Float32Array(CHANNEL_COUNT);

function frameFor(a: number, b: number, t = 0, restriction = 0, noise = 0) {
  const F = deriveFieldParams({ ...condition(a, b, restriction, noise), t }, t);
  sampleRing(F, noise, channels);
  return analyseRing(channels);
}

describe('ring sampling', () => {
  it('produces one non-negative reading per channel', () => {
    const F = deriveFieldParams(condition(12, 12), 0);
    sampleRing(F, 0, channels);
    expect(channels).toHaveLength(CHANNEL_COUNT);
    for (const c of channels) {
      expect(Number.isFinite(c)).toBe(true);
      expect(c).toBeGreaterThanOrEqual(0);
    }
  });

  it('is deterministic for a given condition and time', () => {
    const F = deriveFieldParams(condition(14, 9), 2.5);
    const a = new Float32Array(CHANNEL_COUNT);
    const b = new Float32Array(CHANNEL_COUNT);
    sampleRing(F, 0.3, a);
    sampleRing(F, 0.3, b);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('reads higher overall when more water is going through', () => {
    expect(frameFor(18, 18).mean).toBeGreaterThan(frameFor(9, 9).mean);
  });
});

describe('circumferential features', () => {
  it('reads nearly evenly when the branches are balanced', () => {
    const frame = frameFor(12, 12);
    // Not exactly zero: the model keeps a fixed per-element gain mismatch,
    // because a real ring has one. The baseline is what absorbs it.
    expect(frame.asymmetry).toBeLessThan(0.02);
    expect(frame.sectorImbalance).toBeLessThan(0.15);
  });

  it('develops asymmetry in step with the imbalance', () => {
    const even = frameFor(12, 12).asymmetry;
    const mild = frameFor(14, 10).asymmetry;
    const severe = frameFor(20, 4).asymmetry;
    expect(mild).toBeGreaterThan(even);
    expect(severe).toBeGreaterThan(mild);
  });

  it('puts a modest displacement into mode 1, where an off-centre core belongs', () => {
    // This is the drift regime: the core has moved but is still well inside
    // the bore, so what the ring sees is a single lobe.
    const drifting = frameFor(14, 10);
    expect(drifting.modes[0]).toBeGreaterThan(drifting.modes[1] * 1.5);
    expect(drifting.modes[0]).toBeGreaterThan(drifting.modes[2] * 3);
  });

  it('grows mode 1 with the imbalance', () => {
    expect(frameFor(14, 10).modes[0]).toBeGreaterThan(frameFor(12, 12).modes[0] * 4);
    expect(frameFor(18, 6).modes[0]).toBeGreaterThan(frameFor(14, 10).modes[0]);
  });

  it('goes broadband once the core is pushed hard against the wall', () => {
    // A severely displaced core is a narrow feature sitting among the sample
    // radii rather than a gentle lean across them, and a narrow feature is
    // broadband. Higher modes filling in is therefore itself a signature — it
    // is what separates a disturbance from a drift on the same ring.
    const mild = frameFor(14, 10);
    const severe = frameFor(21, 5, 0, 0.45);

    const mildRatio = mild.modes[1] / mild.modes[0];
    const severeRatio = severe.modes[1] / severe.modes[0];
    expect(severeRatio).toBeGreaterThan(mildRatio * 1.5);
    expect(severe.modes[2]).toBeGreaterThan(mild.modes[2] * 4);
  });

  it('points the mode-1 phase the opposite way for a mirrored imbalance', () => {
    const ab = frameFor(20, 4);
    const ba = frameFor(4, 20);
    let delta = Math.abs(ab.mode1Phase - ba.mode1Phase);
    if (delta > Math.PI) delta = 2 * Math.PI - delta;
    // Roughly half a turn apart: the pattern leans towards whichever branch
    // is delivering more.
    expect(delta).toBeGreaterThan(Math.PI * 0.6);
  });

  it('normalises the distribution to unit mean', () => {
    const frame = frameFor(17, 7);
    const sum = Array.from(frame.distribution).reduce((s, x) => s + x, 0);
    expect(sum / CHANNEL_COUNT).toBeCloseTo(1, 5);
  });

  it('reports a distribution that is scale-invariant', () => {
    // Doubling both branches changes the level, not the pattern, so the shape
    // the ring reports should be almost identical.
    const half = frameFor(7, 3);
    const full = frameFor(14, 6);
    expect(distributionDistance(half.distribution, full.distribution)).toBeLessThan(0.02);
  });
});

describe('baseline', () => {
  const baseline = captureBaseline('test', BASELINE_CONDITION);

  it('is deterministic', () => {
    const again = captureBaseline('test', BASELINE_CONDITION);
    expect(Array.from(again.distribution)).toEqual(Array.from(baseline.distribution));
  });

  it('averages to a unit-mean distribution', () => {
    const sum = Array.from(baseline.distribution).reduce((s, x) => s + x, 0);
    expect(sum / CHANNEL_COUNT).toBeCloseTo(1, 4);
  });

  it('records the spread each channel showed over the capture window', () => {
    for (const s of baseline.spread) {
      expect(Number.isFinite(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
    }
  });

  it('scores the condition it was captured from as almost zero', () => {
    const frame = frameFor(12, 12, 4);
    expect(scoreFrame(frame, baseline)).toBeLessThan(STATE_THRESHOLDS.drift);
  });

  it('absorbs the fixed per-element gain mismatch', () => {
    // A balanced junction scores near zero even though individual channels
    // read a few percent apart, which is only possible if the baseline holds
    // that mismatch rather than the classifier ignoring it.
    const frame = frameFor(12, 12, 7);
    const flat = new Float32Array(CHANNEL_COUNT).fill(1);
    expect(scoreFrame(frame, baseline)).toBeLessThan(
      distributionDistance(frame.distribution, flat),
    );
  });

  it('scores a displaced core well above a balanced one', () => {
    const balanced = scoreFrame(frameFor(12, 12, 4), baseline);
    const drifted = scoreFrame(frameFor(13, 9, 4), baseline);
    const broken = scoreFrame(frameFor(21, 5, 4, 0.45), baseline);
    expect(drifted).toBeGreaterThan(balanced);
    expect(broken).toBeGreaterThan(drifted);
  });
});

describe('state machine', () => {
  it('maps distance onto the four states in order', () => {
    expect(classify(0)).toBe('STABLE');
    expect(classify(STATE_THRESHOLDS.drift + 1e-6)).toBe('DRIFT');
    expect(classify(STATE_THRESHOLDS.preDisturbance + 1e-6)).toBe('PRE_DISTURBANCE');
    expect(classify(STATE_THRESHOLDS.disturbance + 1e-6)).toBe('DISTURBANCE');
    expect(classify(10)).toBe('DISTURBANCE');
  });

  it('keeps the thresholds strictly increasing', () => {
    expect(STATE_THRESHOLDS.drift).toBeLessThan(STATE_THRESHOLDS.preDisturbance);
    expect(STATE_THRESHOLDS.preDisturbance).toBeLessThan(STATE_THRESHOLDS.disturbance);
  });

  it('does not escalate on a hair over the edge', () => {
    const justOver = STATE_THRESHOLDS.drift * 1.05;
    expect(applyHysteresis('STABLE', classify(justOver), justOver)).toBe('STABLE');
  });

  it('escalates once the edge is cleared by the margin', () => {
    const wellOver = STATE_THRESHOLDS.drift * 1.5;
    expect(applyHysteresis('STABLE', classify(wellOver), wellOver)).toBe('DRIFT');
  });

  it('does not de-escalate on a hair under the edge', () => {
    const justUnder = STATE_THRESHOLDS.drift * 0.95;
    expect(applyHysteresis('DRIFT', classify(justUnder), justUnder)).toBe('DRIFT');
  });

  it('de-escalates once the reading has clearly recovered', () => {
    const wellUnder = STATE_THRESHOLDS.drift * 0.5;
    expect(applyHysteresis('DRIFT', classify(wellUnder), wellUnder)).toBe('STABLE');
  });

  it('cannot be pushed past DISTURBANCE or below STABLE', () => {
    expect(applyHysteresis('DISTURBANCE', 'DISTURBANCE', 99)).toBe('DISTURBANCE');
    expect(applyHysteresis('STABLE', 'STABLE', 0)).toBe('STABLE');
  });

  it('holds steady under a reading that oscillates across one edge', () => {
    // A precessing core makes the instantaneous distance swing; without
    // hysteresis the badge would flicker several times a second.
    let state: FlowState = 'STABLE';
    let transitions = 0;
    const edge = STATE_THRESHOLDS.drift;
    for (let i = 0; i < 40; i++) {
      const d = edge * (1 + 0.08 * Math.sin(i));
      const next = applyHysteresis(state, classify(d), d);
      if (next !== state) transitions++;
      state = next;
    }
    expect(transitions).toBe(0);
  });
});
