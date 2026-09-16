import { describe, expect, it } from 'vitest';
import {
  CHAMBER_IN_X,
  CHAMBER_OUT_X,
  GEO,
  OUTLET_END_X,
} from '../src/viz/config/geometry';
import { deriveFieldParams } from '../src/viz/core/fieldParams';
import {
  confine,
  coreCenterAt,
  sampleVelocity,
  wallRadiusAt,
} from '../src/viz/core/flowField';
import { wallRadiusAt as wallRadiusAnalytic } from '../src/viz/core/axialProfile';
import { PORT_A, PORT_B } from '../src/viz/core/junctionPorts';
import { addTurbulence } from '../src/viz/core/turbulence';
import type { JunctionCondition, Vec3 } from '../src/viz/core/types';

/**
 * Tests for the velocity field.
 *
 * These check the properties the visualization actually depends on — that
 * water is conserved, that it stays inside the pipe, that the field is finite
 * everywhere — rather than pinning specific numbers, which would just freeze
 * today's tuning in place.
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

const v: Vec3 = { x: 0, y: 0, z: 0 };

/** Volumetric flux through the outlet plane at x, by polar quadrature. */
function outletFlux(x: number, F: ReturnType<typeof deriveFieldParams>): number {
  const R = wallRadiusAt(x);
  let acc = 0;
  const nr = 48;
  const na = 64;
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

describe('wall profile', () => {
  it('is the same curve the chamber mesh is lathed from', () => {
    for (let x = CHAMBER_IN_X - 1; x < OUTLET_END_X; x += 0.37) {
      expect(wallRadiusAt(x)).toBeCloseTo(wallRadiusAnalytic(x), 10);
    }
  });

  it('opens into the chamber and closes back to the pipe bore', () => {
    expect(wallRadiusAt(0)).toBeGreaterThan(GEO.pipeRadius * 1.5);
    expect(wallRadiusAt(GEO.sensorRingX)).toBeCloseTo(GEO.pipeRadius, 3);
    expect(wallRadiusAt(OUTLET_END_X - 1)).toBeCloseTo(GEO.pipeRadius, 3);
  });
});

describe('continuity', () => {
  it('carries the same volumetric flow through every outlet plane', () => {
    const F = deriveFieldParams(condition(12, 12), 3);
    const stations = [2.4, GEO.sensorRingX, 5.5, 8, OUTLET_END_X - 1];
    const fluxes = stations.map((x) => outletFlux(x, F));

    for (const q of fluxes) {
      // Within 5% of the flow the boundary condition specifies. The residual
      // is quadrature error plus the smooth blends between field regions.
      expect(q / F.qTotal).toBeGreaterThan(0.95);
      expect(q / F.qTotal).toBeLessThan(1.05);
    }

    // And consistent with each other more tightly than with the nominal,
    // because a varying flux would pile particles up at a station.
    const min = Math.min(...fluxes);
    const max = Math.max(...fluxes);
    expect((max - min) / max).toBeLessThan(0.04);
  });

  it('holds when the branches are badly unbalanced', () => {
    const F = deriveFieldParams(condition(21, 5), 3);
    const q = outletFlux(GEO.sensorRingX, F);
    expect(q / F.qTotal).toBeGreaterThan(0.93);
    expect(q / F.qTotal).toBeLessThan(1.07);
  });

  it('holds while the core is recirculating', () => {
    const F = deriveFieldParams(condition(21, 5, 0.5), 3);
    expect(F.axialDeficit).toBeGreaterThan(1);
    const q = outletFlux(GEO.sensorRingX, F);
    // A recirculation bubble moves flux outward rather than removing it.
    expect(q / F.qTotal).toBeGreaterThan(0.9);
    expect(q / F.qTotal).toBeLessThan(1.1);
  });
});

describe('field boundedness', () => {
  it('is finite everywhere, including far outside the pipes', () => {
    const F = deriveFieldParams(condition(12, 12), 1.5);
    for (let x = -20; x <= 20; x += 0.5) {
      for (const r of [0, 0.3, 0.62, 1.5, 6]) {
        for (const a of [0, 1.1, 2.4, 4.0, 5.6]) {
          sampleVelocity(v, x, r * Math.cos(a), r * Math.sin(a), F, -1);
          expect(Number.isFinite(v.x)).toBe(true);
          expect(Number.isFinite(v.y)).toBe(true);
          expect(Number.isFinite(v.z)).toBe(true);
          // Nothing in this scene should move faster than a few multiples of
          // the outlet bulk speed; a blow-up shows up here first.
          expect(Math.hypot(v.x, v.y, v.z)).toBeLessThan(F.uOut * 12 + 1);
        }
      }
    }
  });

  it('stays finite at zero flow', () => {
    const F = deriveFieldParams(condition(0, 0), 2);
    sampleVelocity(v, GEO.sensorRingX, 0, 0, F, -1);
    expect(Number.isFinite(v.x)).toBe(true);
    expect(Math.hypot(v.x, v.y, v.z)).toBeLessThan(1e-6);
  });

  it('stays finite exactly on the axis, where the swirl term divides by rho', () => {
    const F = deriveFieldParams(condition(14, 10), 0.7);
    for (const x of [-1, 0, 1, GEO.sensorRingX, 7]) {
      sampleVelocity(v, x, 0, 0, F, -1);
      expect(Number.isFinite(v.y)).toBe(true);
      expect(Number.isFinite(v.z)).toBe(true);
    }
  });
});

describe('confinement', () => {
  it('pulls a point in the outlet back inside the bore', () => {
    const p: Vec3 = { x: GEO.sensorRingX, y: 4, z: -3 };
    confine(p, 0);
    expect(Math.hypot(p.y, p.z)).toBeLessThanOrEqual(wallRadiusAt(p.x));
  });

  it('confines to the source pipe upstream of the chamber', () => {
    // A point wildly off inlet A's centreline should end up on its wall.
    const start = PORT_A.origin;
    const p: Vec3 = { x: start.x + 1, y: start.y + 5, z: start.z + 5 };
    confine(p, 0);

    const d = PORT_A.direction;
    const ox = p.x - start.x;
    const oy = p.y - start.y;
    const oz = p.z - start.z;
    const s = ox * d.x + oy * d.y + oz * d.z;
    const radial = Math.hypot(ox - s * d.x, oy - s * d.y, oz - s * d.z);
    expect(radial).toBeLessThanOrEqual(GEO.pipeRadius);
  });

  it('routes a particle to the pipe its origin says it came from', () => {
    const pA: Vec3 = { x: CHAMBER_IN_X - 3, y: 0, z: 0 };
    const pB: Vec3 = { x: CHAMBER_IN_X - 3, y: 0, z: 0 };
    confine(pA, 0);
    confine(pB, 1);
    // The two inlets are point-symmetric, so the same start point lands in
    // mirrored places. If origin were ignored they would coincide.
    expect(Math.hypot(pA.y - pB.y, pA.z - pB.z)).toBeGreaterThan(0.1);
    expect(pA.y).toBeCloseTo(-pB.y, 6);
  });
});

describe('turbulence synthesis', () => {
  it('is divergence-free', () => {
    // Central differences of the perturbation alone. A solenoidal field keeps
    // tracers from piling up, which is what stops the water looking like dust.
    const h = 1e-3;
    const at = (x: number, y: number, z: number): Vec3 => {
      const out: Vec3 = { x: 0, y: 0, z: 0 };
      addTurbulence(out, x, y, z, 1.7, 1);
      return out;
    };

    for (const [x, y, z] of [
      [0, 0, 0],
      [1.3, -0.4, 0.25],
      [-2.1, 0.5, -0.3],
      [5.0, 0.2, 0.2],
    ]) {
      const dx = (at(x + h, y, z).x - at(x - h, y, z).x) / (2 * h);
      const dy = (at(x, y + h, z).y - at(x, y - h, z).y) / (2 * h);
      const dz = (at(x, y, z + h).z - at(x, y, z - h).z) / (2 * h);
      const divergence = dx + dy + dz;

      // Compare against the field's own magnitude and length scale rather
      // than against an absolute number.
      const scale = Math.hypot(at(x, y, z).x, at(x, y, z).y, at(x, y, z).z);
      expect(Math.abs(divergence)).toBeLessThan(Math.max(scale, 0.1) * 0.02);
    }
  });

  it('contributes nothing at zero amplitude', () => {
    const out: Vec3 = { x: 1, y: 2, z: 3 };
    addTurbulence(out, 0.4, 0.2, -0.1, 5, 0);
    expect(out).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('is deterministic across calls', () => {
    const a: Vec3 = { x: 0, y: 0, z: 0 };
    const b: Vec3 = { x: 0, y: 0, z: 0 };
    addTurbulence(a, 1.1, 0.3, -0.2, 4.4, 1);
    addTurbulence(b, 1.1, 0.3, -0.2, 4.4, 1);
    expect(a).toEqual(b);
  });
});

describe('flow direction', () => {
  it('accelerates from the chamber into the narrower outlet', () => {
    const F = deriveFieldParams(condition(12, 12), 2);
    sampleVelocity(v, 0, 0.1, 0.1, F, -1);
    const inChamber = v.x;
    sampleVelocity(v, GEO.sensorRingX, 0.1, 0.1, F, -1);
    const inOutlet = v.x;
    expect(inOutlet).toBeGreaterThan(inChamber * 1.5);
  });

  it('swirls about the axis in the outlet', () => {
    const F = deriveFieldParams(condition(12, 12), 2);
    const r = GEO.pipeRadius * 0.7;
    sampleVelocity(v, GEO.sensorRingX, r, 0, F, -1);
    // At (y=r, z=0) the tangential direction is +z for positive circulation.
    expect(v.z).toBeGreaterThan(0);
    expect(Math.abs(v.z)).toBeGreaterThan(0.05 * Math.abs(v.x));
  });

  it('reverses on the core once the deficit exceeds the through-flow', () => {
    const F = deriveFieldParams(condition(21, 5, 0.75), 2);
    expect(F.axialDeficit).toBeGreaterThan(1.2);

    // Sample on the core line itself, wherever growth, relaxation and
    // precession have actually put it.
    const core = { y: 0, z: 0 };
    let sawReversal = false;
    for (let x = CHAMBER_OUT_X; x < GEO.sensorRingX + 1; x += 0.2) {
      coreCenterAt(x, F, core);
      sampleVelocity(v, x, core.y, core.z, F, -1);
      if (v.x < 0) sawReversal = true;
    }
    expect(sawReversal).toBe(true);
  });
});

describe('inlet ports', () => {
  it('places the two ports point-symmetrically about the axis', () => {
    expect(PORT_A.position.y).toBeCloseTo(-PORT_B.position.y, 10);
    expect(PORT_A.position.z).toBeCloseTo(-PORT_B.position.z, 10);
    expect(PORT_A.direction.x).toBeCloseTo(PORT_B.direction.x, 10);
    expect(PORT_A.direction.y).toBeCloseTo(-PORT_B.direction.y, 10);
  });

  it('injects co-rotating swirl from both branches', () => {
    // If these had opposite signs the branches would cancel each other's
    // rotation and the chamber would not swirl at all.
    expect(PORT_A.specificSwirl).toBeGreaterThan(0);
    expect(PORT_B.specificSwirl).toBeGreaterThan(0);
    expect(PORT_A.specificSwirl).toBeCloseTo(PORT_B.specificSwirl, 10);
  });

  it('has unit direction vectors', () => {
    for (const port of [PORT_A, PORT_B]) {
      const { x, y, z } = port.direction;
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 12);
    }
  });
});
