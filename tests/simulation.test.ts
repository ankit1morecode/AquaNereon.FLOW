import { describe, expect, it } from 'vitest';
import { GEO, OUTLET_END_X } from '../src/viz/config/geometry';
import { deriveFieldParams } from '../src/viz/core/fieldParams';
import { wallRadiusAt } from '../src/viz/core/flowField';
import { ParticleSystem } from '../src/viz/sim/ParticleSystem';
import { StreamlineSet } from '../src/viz/sim/Streamlines';
import { SignatureHistory } from '../src/viz/sim/SignatureHistory';
import {
  nearestQuality,
  QUALITY_LEVELS,
  SimulationEngine,
} from '../src/viz/sim/SimulationEngine';
import {
  findScenario,
  ManualFlowSource,
  SyntheticFlowSource,
} from '../src/viz/data/SyntheticFlowSource';
import type { FlowSignature, JunctionCondition } from '../src/viz/core/types';

function condition(a: number, b: number, restriction = 0): JunctionCondition {
  return {
    t: 0,
    inletA: { flowLps: a, pressureKpa: 300, temperatureC: 21 },
    inletB: { flowLps: b, pressureKpa: 300, temperatureC: 21 },
    downstreamRestriction: restriction,
    noiseLevel: 0.1,
  };
}

/** Advance a particle system far enough for the pipes to fill. */
function settle(system: ParticleSystem, seconds: number, condition: JunctionCondition) {
  const dt = 1 / 60;
  for (let i = 0; i < seconds / dt; i++) {
    system.step(dt, deriveFieldParams(condition, i * dt));
  }
}

function countOrigins(system: ParticleSystem): { fromA: number; fromB: number } {
  let fromA = 0;
  let fromB = 0;
  for (let i = 0; i < system.count; i++) {
    if (system.buffers.positions[i * 3] <= -5000) continue;
    if (system.buffers.origins[i] > 0.5) fromB++;
    else fromA++;
  }
  return { fromA, fromB };
}

function livePositions(system: ParticleSystem): { x: number; y: number; z: number }[] {
  const out: { x: number; y: number; z: number }[] = [];
  const p = system.buffers.positions;
  for (let i = 0; i < system.count; i++) {
    const x = p[i * 3];
    if (x > -5000) out.push({ x, y: p[i * 3 + 1], z: p[i * 3 + 2] });
  }
  return out;
}

describe('particle system', () => {
  it('fills the pipes from empty', () => {
    const system = new ParticleSystem(1500);
    expect(livePositions(system)).toHaveLength(0);
    settle(system, 10, condition(12, 12));
    expect(livePositions(system).length).toBeGreaterThan(1000);
  });

  it('keeps every tracer inside the drawn bore', () => {
    const system = new ParticleSystem(1200);
    settle(system, 12, condition(12, 12));

    for (const p of livePositions(system)) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(p.x).toBeLessThanOrEqual(OUTLET_END_X + 0.01);
      // Downstream of the chamber face everything shares one axis, so the
      // wall curve applies directly.
      if (p.x > -GEO.junctionHalfLength + 0.3) {
        const r = Math.hypot(p.y, p.z);
        expect(r).toBeLessThanOrEqual(wallRadiusAt(p.x) + 1e-3);
      }
    }
  });

  it('holds inside the bore even when the core is recirculating', () => {
    const system = new ParticleSystem(1200);
    settle(system, 14, condition(21, 5, 0.6));
    for (const p of livePositions(system)) {
      if (p.x > -GEO.junctionHalfLength + 0.3) {
        expect(Math.hypot(p.y, p.z)).toBeLessThanOrEqual(wallRadiusAt(p.x) + 1e-3);
      }
    }
  });

  it('mixes the two branches evenly when they are balanced', () => {
    const system = new ParticleSystem(2000);
    settle(system, 13, condition(12, 12));
    const { fromA, fromB } = countOrigins(system);
    expect(fromA / fromB).toBeGreaterThan(0.85);
    expect(fromA / fromB).toBeLessThan(1.18);
  });

  it('lets the stronger branch dominate the mix', () => {
    const system = new ParticleSystem(2000);
    settle(system, 13, condition(18, 6));
    const { fromA, fromB } = countOrigins(system);

    // Not the full 3:1 of the flow ratio. Tracers are seeded at constant
    // concentration, so each inlet pipe holds a similar number whatever its
    // speed; the dominance only shows up downstream of the merge, where both
    // streams travel at the same outlet velocity. The visible imbalance in the
    // inlet runs comes from streak length, not from tracer count.
    expect(fromA).toBeGreaterThan(fromB * 1.3);
  });

  it('records a velocity for every live tracer, for the streak renderer', () => {
    const system = new ParticleSystem(800);
    settle(system, 8, condition(12, 12));
    const v = system.buffers.velocities;
    let checked = 0;
    for (let i = 0; i < system.count; i++) {
      if (system.buffers.positions[i * 3] <= -5000) continue;
      const speed = Math.hypot(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]);
      expect(Number.isFinite(speed)).toBe(true);
      expect(speed).toBeGreaterThan(0);
      checked++;
    }
    expect(checked).toBeGreaterThan(300);
  });

  it('survives a huge frame delta without flinging tracers out', () => {
    const system = new ParticleSystem(500);
    settle(system, 6, condition(12, 12));
    // The engine clamps dt, but the system itself must not explode if handed
    // a large one directly.
    system.step(0.5, deriveFieldParams(condition(12, 12), 6));
    for (const p of livePositions(system)) {
      expect(Number.isFinite(p.x)).toBe(true);
      if (p.x > -GEO.junctionHalfLength + 0.3) {
        expect(Math.hypot(p.y, p.z)).toBeLessThanOrEqual(wallRadiusAt(p.x) + 1e-3);
      }
    }
  });

  it('does nothing at zero flow rather than dividing by it', () => {
    const system = new ParticleSystem(300);
    settle(system, 3, condition(0, 0));
    for (const p of livePositions(system)) expect(Number.isFinite(p.x)).toBe(true);
  });

  it('is reproducible for a given seed', () => {
    const a = new ParticleSystem(200, 1234);
    const b = new ParticleSystem(200, 1234);
    settle(a, 5, condition(13, 11));
    settle(b, 5, condition(13, 11));
    expect(Array.from(a.buffers.positions)).toEqual(Array.from(b.buffers.positions));
  });
});

describe('streamlines', () => {
  it('integrates lines that stay inside the geometry', () => {
    const set = new StreamlineSet(8, 120);
    set.rebuild(deriveFieldParams(condition(12, 12), 1));

    let withPoints = 0;
    for (const line of set.lines) {
      if (line.sampleCount < 2) continue;
      withPoints++;
      for (let i = 0; i < line.sampleCount; i++) {
        const x = line.points[i * 3];
        expect(Number.isFinite(x)).toBe(true);
        expect(x).toBeLessThanOrEqual(OUTLET_END_X + 0.01);
      }
    }
    expect(withPoints).toBeGreaterThan(5);
  });

  it('carries lines from both branches', () => {
    const set = new StreamlineSet(8, 60);
    const origins = new Set(set.lines.map((l) => l.origin));
    expect(origins).toEqual(new Set([0, 1]));
  });

  it('bumps a version only for the lines it re-integrated', () => {
    const set = new StreamlineSet(6, 60);
    const F = deriveFieldParams(condition(12, 12), 1);
    set.rebuild(F);
    const before = set.lines.map((l) => l.version);

    set.update(F, 2);
    const after = set.lines.map((l) => l.version);
    const changed = after.filter((v, i) => v !== before[i]).length;
    expect(changed).toBe(2);
  });

  it('travels downstream from the inlets', () => {
    const set = new StreamlineSet(6, 150);
    set.rebuild(deriveFieldParams(condition(12, 12), 1));
    const line = set.lines.find((l) => l.sampleCount > 50);
    expect(line).toBeDefined();
    const firstX = line!.points[0];
    const lastX = line!.points[(line!.sampleCount - 1) * 3];
    expect(lastX).toBeGreaterThan(firstX);
  });
});

describe('signature history', () => {
  const fakeSignature = (distribution: number[], distance: number): FlowSignature =>
    ({
      channels: new Float32Array(distribution),
      distribution: new Float32Array(distribution),
      mean: 1,
      variance: 0,
      maxMinusMin: 0,
      asymmetry: 0,
      sectorImbalance: 0,
      spatialGradient: 0,
      modes: [0, 0, 0],
      mode1Phase: 0,
      swirlNumber: 0.45,
      baselineDistance: distance,
      state: distance > 0.05 ? 'DRIFT' : 'STABLE',
    }) as FlowSignature;

  const flat = new Array(16).fill(1);

  it('records at its own rate, not on every offered frame', () => {
    const history = new SignatureHistory();
    for (let i = 0; i < 100; i++) history.record(fakeSignature(flat, 0), i / 100, 1 / 100);
    // 1 second at 100 fps, sampled at HISTORY_HZ.
    expect(history.length).toBeGreaterThan(15);
    expect(history.length).toBeLessThan(25);
  });

  it('never grows past its capacity', () => {
    const history = new SignatureHistory();
    for (let i = 0; i < 20000; i++) history.record(fakeSignature(flat, 0), i / 20, 1 / 20);
    expect(history.length).toBe(history.capacity);
  });

  it('keeps the newest sample at the end after wrapping', () => {
    const history = new SignatureHistory();
    for (let i = 0; i < history.capacity + 50; i++) {
      history.record(fakeSignature(new Array(16).fill(i), 0), i / 20, 1 / 20);
    }
    const last = history.channelAt(history.length - 1, 0);
    const first = history.channelAt(0, 0);
    expect(last).toBeGreaterThan(first);
  });

  it('measures a rising trend as a positive slope', () => {
    const history = new SignatureHistory();
    for (let i = 0; i < 200; i++) {
      history.record(fakeSignature(flat, i * 0.001), i / 20, 1 / 20);
    }
    expect(history.distanceSlope(4)).toBeGreaterThan(0.01);
  });

  it('measures a steady reading as no trend', () => {
    const history = new SignatureHistory();
    for (let i = 0; i < 200; i++) history.record(fakeSignature(flat, 0.03), i / 20, 1 / 20);
    expect(Math.abs(history.distanceSlope(4))).toBeLessThan(1e-6);
  });

  it('reports persistence as the fraction of the window above STABLE', () => {
    const history = new SignatureHistory();
    for (let i = 0; i < 400; i++) {
      // Second half of the run is in DRIFT.
      history.record(fakeSignature(flat, i > 200 ? 0.1 : 0.0), i / 20, 1 / 20);
    }
    expect(history.persistence(8)).toBeCloseTo(1, 1);
  });

  it('is empty after a clear', () => {
    const history = new SignatureHistory();
    for (let i = 0; i < 100; i++) history.record(fakeSignature(flat, 0), i / 20, 1 / 20);
    history.clear();
    expect(history.length).toBe(0);
    expect(history.distanceSlope()).toBe(0);
    expect(history.persistence()).toBe(0);
  });
});

describe('simulation engine', () => {
  const build = () =>
    new SimulationEngine(new SyntheticFlowSource(findScenario('NORMAL')), {
      particleCount: 400,
      streamlineCount: 4,
    });

  it('produces a signature before it has been stepped', () => {
    const engine = build();
    expect(engine.signature.state).toBe('STABLE');
    expect(engine.signature.distribution).toHaveLength(16);
  });

  it('advances simulated time at the playback rate', () => {
    const engine = build();
    engine.timeScale = 2;
    engine.step(1 / 60);
    expect(engine.time).toBeCloseTo(2 / 60, 6);
  });

  it('clamps a huge wall-clock delta', () => {
    const engine = build();
    engine.step(30);
    expect(engine.time).toBeLessThan(0.1);
  });

  it('ignores a zero or negative delta', () => {
    const engine = build();
    engine.step(0);
    engine.step(-1);
    expect(engine.time).toBe(0);
  });

  it('seeks without losing the tracers already in the pipe', () => {
    const engine = build();
    for (let i = 0; i < 400; i++) engine.step(1 / 60);
    const before = livePositions(engine.particles).length;
    engine.seek(12);
    expect(engine.time).toBe(12);
    expect(livePositions(engine.particles).length).toBe(before);
    expect(engine.history.length).toBe(0);
  });

  it('refreshes the condition immediately on seek, without a step', () => {
    const engine = new SimulationEngine(
      new SyntheticFlowSource(findScenario('DISTURBANCE')),
      { particleCount: 200, streamlineCount: 4 },
    );
    engine.seek(12);
    // Twelve seconds into the disturbance, branch A is well ahead of B.
    expect(engine.condition.inletA.flowLps).toBeGreaterThan(
      engine.condition.inletB.flowLps * 2,
    );
  });

  it('swaps sources without being rebuilt', () => {
    const engine = build();
    const manual = new ManualFlowSource();
    manual.flowA = 20;
    manual.flowB = 4;
    engine.setSource(manual);
    expect(engine.getSource().id).toBe('MANUAL');
    expect(engine.condition.inletA.flowLps).toBe(20);
    // The baseline survives the swap: it describes the hardware, not the feed.
    expect(engine.baseline.id).toBe('balanced-12-12');
  });

  it('changes the tracer budget on demand', () => {
    const engine = build();
    engine.setParticleCount(QUALITY_LEVELS.low);
    expect(engine.particles.count).toBe(QUALITY_LEVELS.low);
    engine.step(1 / 60);
    expect(engine.signature.distribution).toHaveLength(16);
  });

  it('fills its history as it runs', () => {
    const engine = build();
    for (let i = 0; i < 300; i++) engine.step(1 / 60);
    expect(engine.history.length).toBeGreaterThan(50);
  });

  it('reaches DISTURBANCE when run through that scenario', () => {
    const engine = new SimulationEngine(
      new SyntheticFlowSource(findScenario('DISTURBANCE')),
      { particleCount: 200, streamlineCount: 4 },
    );
    const seen = new Set<string>();
    for (let i = 0; i < 30 * 30; i++) {
      engine.step(1 / 30);
      seen.add(engine.signature.state);
    }
    expect(seen.has('DISTURBANCE')).toBe(true);
  });
});

describe('quality levels', () => {
  it('orders low, medium and high by tracer count', () => {
    expect(QUALITY_LEVELS.low).toBeLessThan(QUALITY_LEVELS.medium);
    expect(QUALITY_LEVELS.medium).toBeLessThan(QUALITY_LEVELS.high);
  });

  it('maps an arbitrary count to the nearest named level', () => {
    expect(nearestQuality(QUALITY_LEVELS.low)).toBe('low');
    expect(nearestQuality(QUALITY_LEVELS.high + 9000)).toBe('high');
    expect(nearestQuality(1)).toBe('low');
  });
});
