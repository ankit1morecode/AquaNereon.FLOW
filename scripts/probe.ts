/**
 * Headless check that the flow model actually separates the three scenarios.
 *
 * Run with:  npm run probe
 *
 * This is the validation the software dossier asks for in 31.1: the scenarios
 * are not hard-coded to produce a state, so it is worth confirming that the
 * states they do produce come out of the measurement chain.
 */
import { deriveFieldParams } from '../src/viz/core/fieldParams';
import { analyseRing, sampleRing, CHANNEL_COUNT } from '../src/viz/core/sensorRing';
import { buildSignature, captureBaseline, scoreFrame, PERSISTENCE_TAU } from '../src/viz/core/baseline';
import { sampleVelocity } from '../src/viz/core/flowField';
import { GEO, OUTLET_END_X } from '../src/viz/config/geometry';
import {
  BASELINE_CONDITION,
  findScenario,
  SyntheticFlowSource,
} from '../src/viz/data/SyntheticFlowSource';
import type { FlowState } from '../src/viz/core/types';

const baseline = captureBaseline('balanced-12-12', BASELINE_CONDITION);

function pad(s: string, n: number) {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
function num(v: number, w = 7, d = 3) {
  return pad(v.toFixed(d), w);
}

console.log('\n=== BASELINE ===');
console.log(
  'distribution:',
  Array.from(baseline.distribution)
    .map((v) => v.toFixed(3))
    .join(' '),
);
console.log('swirl number:', baseline.swirlNumber.toFixed(3));
console.log('asymmetry:   ', baseline.asymmetry.toFixed(4));

const channels = new Float32Array(CHANNEL_COUNT);

for (const id of ['NORMAL', 'DRIFT', 'DISTURBANCE']) {
  const source = new SyntheticFlowSource(findScenario(id));
  console.log(`\n=== ${id} (${source.durationSec}s) ===`);
  console.log(
    pad('t', 5) +
      pad('A L/s', 8) +
      pad('B L/s', 8) +
      pad('swirl', 8) +
      pad('deficit', 9) +
      pad('asym', 8) +
      pad('imbal', 8) +
      pad('mode1', 8) +
      pad('dist', 8) +
      'state',
  );

  const seen = new Set<FlowState>();
  let state: FlowState = 'STABLE';
  let persisted = 0;
  // Step at display rate so the persistence filter sees the same cadence the
  // running engine does.
  const dt = 1 / 30;
  const steps = Math.round(source.durationSec / dt);
  const reportEvery = Math.round(steps / 8);
  for (let s = 0; s <= steps; s++) {
    const t = s * dt;
    const cond = source.sample(t);
    const F = deriveFieldParams(cond, t);
    sampleRing(F, cond.noiseLevel, channels);
    const frame = analyseRing(channels);
    const instant = scoreFrame(frame, baseline);
    persisted += (instant - persisted) * (1 - Math.exp(-dt / PERSISTENCE_TAU));
    const sig = buildSignature(frame, F.swirlNumber, persisted, state);
    state = sig.state;
    seen.add(state);

    if (s % reportEvery === 0) {
      console.log(
        pad(t.toFixed(1), 5) +
          num(cond.inletA.flowLps, 8, 1) +
          num(cond.inletB.flowLps, 8, 1) +
          num(F.swirlNumber, 8) +
          num(F.axialDeficit, 9) +
          num(sig.asymmetry, 8, 4) +
          num(sig.sectorImbalance, 8) +
          num(sig.modes[0], 8) +
          num(sig.baselineDistance, 8) +
          state,
      );
    }
  }
  console.log('states reached:', [...seen].join(' -> '));
}

/* ---- field sanity: continuity and containment ---- */
console.log('\n=== FIELD SANITY ===');
const cond = findScenario('NORMAL');
const src = new SyntheticFlowSource(cond);
const F = deriveFieldParams(src.sample(3), 3);
const v = { x: 0, y: 0, z: 0 };

console.log(pad('x', 7) + pad('ux(axis)', 11) + pad('ux(wall)', 11) + pad('|vtheta|', 11));
for (const x of [-6, -2, -1.4, -0.5, 0, 1, 1.6, 2.5, GEO.sensorRingX, 8, 12]) {
  sampleVelocity(v, x, 0.02, 0.02, F, -1);
  const axis = v.x;
  const r = GEO.pipeRadius * 0.85;
  sampleVelocity(v, x, r, 0, F, -1);
  const wall = v.x;
  const vt = Math.hypot(v.y, v.z);
  console.log(pad(x.toFixed(2), 7) + num(axis, 11) + num(wall, 11) + num(vt, 11));
}

// Volumetric flux across a few outlet planes: continuity should hold to within
// the discretisation error of the quadrature.
function fluxAt(x: number): number {
  const R = GEO.pipeRadius;
  let acc = 0;
  const nr = 40;
  const na = 48;
  for (let i = 0; i < nr; i++) {
    const r0 = (i / nr) * R;
    const r1 = ((i + 1) / nr) * R;
    const rm = (r0 + r1) / 2;
    const dA = (Math.PI * (r1 * r1 - r0 * r0)) / na;
    for (let j = 0; j < na; j++) {
      const a = ((j + 0.5) / na) * Math.PI * 2;
      sampleVelocity(v, x, rm * Math.cos(a), rm * Math.sin(a), F, -1);
      acc += v.x * dA;
    }
  }
  return acc;
}
console.log('\noutlet volumetric flux (world^3/s), should be ~constant:');
for (const x of [2.2, GEO.sensorRingX, 6, 9, OUTLET_END_X - 1]) {
  console.log(`  x=${pad(x.toFixed(2), 6)} Q=${fluxAt(x).toFixed(4)}  (qTotal=${F.qTotal.toFixed(4)})`);
}
