import { GEO, OUTLET_END_X } from '../config/geometry';
import { confine, sampleVelocity } from '../core/flowField';
import { PORT_A, PORT_B } from '../core/junctionPorts';
import { makeRng, type Vec3 } from '../core/math';
import type { FieldParams } from '../core/types';

/**
 * Instantaneous streamlines through the junction.
 *
 * Where the particles show what the water is doing over time, these show the
 * shape of the field right now: they make the spiral legible as a structure
 * rather than as a texture. Each line is re-integrated on a rota so the work
 * spreads across frames and the lines still track a changing field.
 */

export interface Streamline {
  points: Float32Array; // 3 floats per sample
  sampleCount: number;
  /** 0 = seeded in inlet A, 1 = inlet B. */
  origin: number;
  /** Bumped on every re-integration so renderers can skip unchanged lines. */
  version: number;
}

const tmpVel: Vec3 = { x: 0, y: 0, z: 0 };
const tmpPos: Vec3 = { x: 0, y: 0, z: 0 };

export class StreamlineSet {
  readonly lines: Streamline[] = [];
  private readonly seeds: Float32Array;
  private cursor = 0;

  constructor(
    readonly count = 16,
    readonly samplesPerLine = 190,
    seed = 0x571ea3,
  ) {
    const rng = makeRng(seed);
    this.seeds = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      const fromB = i % 2 === 1;
      const port = fromB ? PORT_B : PORT_A;
      const d = port.direction;

      // Seed on a ring inside the pipe rather than uniformly: streamlines
      // launched from the middle all collapse onto the axis and tell you
      // nothing about the swirl.
      const r = GEO.pipeRadius * (0.3 + 0.55 * rng());
      const a = (i / count) * Math.PI * 2 * 2 + rng() * 0.4;

      const upX = Math.abs(d.x) < 0.9 ? 1 : 0;
      const upY = Math.abs(d.x) < 0.9 ? 0 : 1;
      let e1x = -d.z * upY;
      let e1y = d.z * upX;
      let e1z = d.x * upY - d.y * upX;
      const l1 = Math.hypot(e1x, e1y, e1z) || 1;
      e1x /= l1;
      e1y /= l1;
      e1z /= l1;
      const e2x = d.y * e1z - d.z * e1y;
      const e2y = d.z * e1x - d.x * e1z;
      const e2z = d.x * e1y - d.y * e1x;

      const ox = r * Math.cos(a);
      const oy = r * Math.sin(a);
      const along = GEO.inletLength * 0.42;

      this.seeds[i * 3] = port.origin.x + d.x * along + e1x * ox + e2x * oy;
      this.seeds[i * 3 + 1] = port.origin.y + d.y * along + e1y * ox + e2y * oy;
      this.seeds[i * 3 + 2] = port.origin.z + d.z * along + e1z * ox + e2z * oy;

      this.lines.push({
        points: new Float32Array(this.samplesPerLine * 3),
        sampleCount: 0,
        origin: fromB ? 1 : 0,
        version: 0,
      });
    }
  }

  /** Re-integrate `budget` lines this frame, round-robin. */
  update(F: FieldParams, budget = 3): void {
    for (let n = 0; n < budget; n++) {
      this.integrate(this.cursor, F);
      this.cursor = (this.cursor + 1) % this.count;
    }
  }

  /** Force a full rebuild, e.g. after a scenario change. */
  rebuild(F: FieldParams): void {
    for (let i = 0; i < this.count; i++) this.integrate(i, F);
  }

  private integrate(index: number, F: FieldParams): void {
    const line = this.lines[index];
    const pts = line.points;
    let px = this.seeds[index * 3];
    let py = this.seeds[index * 3 + 1];
    let pz = this.seeds[index * 3 + 2];

    // A fixed arc-length step keeps the line smooth through the fast outlet
    // and the slow chamber alike.
    const ds = 0.13;
    let written = 0;

    for (let s = 0; s < this.samplesPerLine; s++) {
      pts[written * 3] = px;
      pts[written * 3 + 1] = py;
      pts[written * 3 + 2] = pz;
      written++;

      sampleVelocity(tmpVel, px, py, pz, F, line.origin);
      const v = Math.hypot(tmpVel.x, tmpVel.y, tmpVel.z);
      if (v < 1e-5) break;

      const h = ds / v;
      const hx = px + tmpVel.x * h * 0.5;
      const hy = py + tmpVel.y * h * 0.5;
      const hz = pz + tmpVel.z * h * 0.5;
      sampleVelocity(tmpVel, hx, hy, hz, F, line.origin);
      const v2 = Math.hypot(tmpVel.x, tmpVel.y, tmpVel.z);
      if (v2 < 1e-5) break;
      const h2 = ds / v2;

      px += tmpVel.x * h2;
      py += tmpVel.y * h2;
      pz += tmpVel.z * h2;

      tmpPos.x = px;
      tmpPos.y = py;
      tmpPos.z = pz;
      confine(tmpPos, line.origin);
      px = tmpPos.x;
      py = tmpPos.y;
      pz = tmpPos.z;

      if (px > OUTLET_END_X - 0.4 || !Number.isFinite(px)) break;
    }

    // Degenerate lines (a seed that lands in a stagnation point) would render
    // as a dot; drop them rather than draw them.
    line.sampleCount = written > 3 ? written : 0;
    line.version++;
  }
}
