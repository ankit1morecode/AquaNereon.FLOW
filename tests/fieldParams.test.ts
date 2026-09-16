import { describe, expect, it } from 'vitest';
import { PIPE_AREA_M2 } from '../src/viz/config/geometry';
import {
  deriveFieldParams,
  outletReynolds,
  outletVelocityMs,
} from '../src/viz/core/fieldParams';
import type { JunctionCondition } from '../src/viz/core/types';

/**
 * Tests for the momentum bookkeeping.
 *
 * The central claim of the whole module is that an imbalance between the two
 * branches *causes* the circumferential asymmetry, rather than being mapped to
 * it by an animation curve. These check the causal step where that happens.
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

const coreOffset = (a: number, b: number) => {
  const F = deriveFieldParams(condition(a, b), 0);
  return Math.hypot(F.coreOffsetY, F.coreOffsetZ);
};

const lean = (a: number, b: number) => {
  const F = deriveFieldParams(condition(a, b), 0);
  return Math.hypot(F.leanY, F.leanZ);
};

describe('bulk velocities', () => {
  it('follows Q / A', () => {
    const F = deriveFieldParams(condition(12, 12), 0);
    // 24 L/s through the outlet bore.
    expect(outletVelocityMs(condition(12, 12))).toBeCloseTo(0.024 / PIPE_AREA_M2, 6);
    // Outlet carries both branches, so it is faster than either.
    expect(F.uOut).toBeGreaterThan(F.uA);
    expect(F.uOut).toBeCloseTo(F.uA + F.uB, 6);
  });

  it('reports a turbulent Reynolds number at design flow', () => {
    // Around 2 m/s in a 124 mm bore: firmly turbulent, which is what justifies
    // the blunt pipe profile the field uses instead of a parabolic one.
    expect(outletReynolds(condition(12, 12))).toBeGreaterThan(1e5);
  });

  it('is zero everywhere at zero flow', () => {
    const F = deriveFieldParams(condition(0, 0), 0);
    expect(F.uOut).toBe(0);
    expect(F.qTotal).toBe(0);
    expect(F.circulation).toBe(0);
  });

  it('treats negative flow as zero rather than reversing', () => {
    const F = deriveFieldParams(condition(-5, 12), 0);
    expect(F.uA).toBe(0);
    expect(F.uB).toBeGreaterThan(0);
  });
});

describe('swirl', () => {
  it('is a property of the geometry, not of the flow rate', () => {
    // Both branches inject the same specific angular momentum, so the swirl
    // number is set by where the ports are, not by how much is coming in.
    const balanced = deriveFieldParams(condition(12, 12), 0).swirlNumber;
    const doubled = deriveFieldParams(condition(24, 24), 0).swirlNumber;
    const unbalanced = deriveFieldParams(condition(20, 4), 0).swirlNumber;
    expect(doubled).toBeCloseTo(balanced, 6);
    expect(unbalanced).toBeCloseTo(balanced, 6);
  });

  it('is strong enough to organise a vortex', () => {
    const S = deriveFieldParams(condition(12, 12), 0).swirlNumber;
    expect(S).toBeGreaterThan(0.2);
    expect(S).toBeLessThan(1.2);
  });

  it('scales circulation with throughput', () => {
    const slow = deriveFieldParams(condition(6, 6), 0).circulation;
    const fast = deriveFieldParams(condition(12, 12), 0).circulation;
    expect(fast).toBeGreaterThan(slow * 1.5);
  });
});

describe('imbalance drives the asymmetry', () => {
  it('leaves the core centred when the branches are balanced', () => {
    expect(coreOffset(12, 12)).toBeCloseTo(0, 9);
    expect(lean(12, 12)).toBeCloseTo(0, 9);
  });

  it('displaces the core once they are not', () => {
    expect(coreOffset(14, 10)).toBeGreaterThan(0);
    expect(coreOffset(18, 6)).toBeGreaterThan(coreOffset(14, 10));
  });

  it('leans the momentum profile in step with the displacement', () => {
    expect(lean(14, 10)).toBeGreaterThan(0);
    expect(lean(18, 6)).toBeGreaterThan(lean(14, 10));
  });

  it('displaces in opposite directions for mirrored imbalances', () => {
    const ab = deriveFieldParams(condition(18, 6), 0);
    const ba = deriveFieldParams(condition(6, 18), 0);
    expect(ab.coreOffsetY).toBeCloseTo(-ba.coreOffsetY, 9);
    expect(ab.coreOffsetZ).toBeCloseTo(-ba.coreOffsetZ, 9);
    expect(ab.leanY).toBeCloseTo(-ba.leanY, 9);
  });

  it('does not depend on total flow, only on the ratio', () => {
    // Momentum flux goes as Q squared for both branches, so the bias is a
    // ratio and a proportional increase in both should change nothing.
    const small = deriveFieldParams(condition(9, 3), 0);
    const large = deriveFieldParams(condition(18, 6), 0);
    expect(small.coreOffsetY).toBeCloseTo(large.coreOffsetY, 9);
    expect(small.leanY).toBeCloseTo(large.leanY, 9);
  });

  it('caps the displacement inside the bore', () => {
    // Even a fully collapsed branch must not put the core through the wall.
    const F = deriveFieldParams(condition(24, 0), 0);
    expect(Math.hypot(F.coreOffsetY, F.coreOffsetZ)).toBeLessThan(0.5);
  });
});

describe('breakdown', () => {
  it('stays below recirculation at balanced design flow', () => {
    expect(deriveFieldParams(condition(12, 12), 0).axialDeficit).toBeLessThan(0.6);
  });

  it('is brought on by a downstream restriction', () => {
    const clear = deriveFieldParams(condition(12, 12, 0), 0).axialDeficit;
    const choked = deriveFieldParams(condition(12, 12, 0.7), 0).axialDeficit;
    expect(choked).toBeGreaterThan(clear);
    expect(choked).toBeGreaterThan(1);
  });

  it('is brought on by shear between the branches', () => {
    const even = deriveFieldParams(condition(12, 12), 0).axialDeficit;
    const sheared = deriveFieldParams(condition(21, 3), 0).axialDeficit;
    expect(sheared).toBeGreaterThan(even);
  });

  it('makes the core precess harder once it has broken down', () => {
    const calm = deriveFieldParams(condition(12, 12), 0);
    const broken = deriveFieldParams(condition(21, 5, 0.5), 0);
    expect(broken.precessAmp).toBeGreaterThan(calm.precessAmp);
    expect(broken.axialDeficit).toBeGreaterThan(1);
  });
});

describe('turbulence intensity', () => {
  it('rises with shear, restriction and reported noise', () => {
    const base = deriveFieldParams(condition(12, 12, 0, 0), 0).turbIntensity;
    expect(deriveFieldParams(condition(20, 4, 0, 0), 0).turbIntensity).toBeGreaterThan(base);
    expect(deriveFieldParams(condition(12, 12, 0.5, 0), 0).turbIntensity).toBeGreaterThan(base);
    expect(deriveFieldParams(condition(12, 12, 0, 1), 0).turbIntensity).toBeGreaterThan(base);
  });
});
