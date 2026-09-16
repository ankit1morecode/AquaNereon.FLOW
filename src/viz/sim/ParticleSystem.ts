import { GEO, NOMINAL_OUTLET_SPEED, OUTLET_END_X } from '../config/geometry';
import { confine, sampleVelocity } from '../core/flowField';
import { PORT_A, PORT_B } from '../core/junctionPorts';
import { clamp, makeRng, type Vec3 } from '../core/math';
import type { FieldParams } from '../core/types';

/**
 * CPU-advected tracer particles.
 *
 * Positions live in a plain Float32Array that is handed straight to a
 * BufferAttribute, so the only per-frame GPU traffic is one buffer upload.
 * Advection stays on the CPU on purpose: the velocity field is the same
 * TypeScript function the sensor model samples, which means the water you
 * watch and the pattern the ring reports come from one source of truth. A
 * GPGPU port would have to duplicate the field in GLSL and the two would
 * drift apart.
 *
 * Particles are seeded in proportion to each branch's flow rate and carry
 * their origin with them, so when one branch dominates you can see it in the
 * mix downstream rather than having to be told.
 */

export interface ParticleBuffers {
  positions: Float32Array;
  /**
   * Velocity in world units/s. The renderer draws each tracer as a streak
   * along this vector, so it has to be the velocity actually used to move the
   * particle rather than a re-sampled approximation of it.
   */
  velocities: Float32Array;
  /** Speed normalised against the outlet bulk velocity. */
  speeds: Float32Array;
  /** 0 = inlet A, 1 = inlet B. */
  origins: Float32Array;
  /** Fade-in on respawn so particles do not pop into existence. */
  alphas: Float32Array;
}

const tmpVel: Vec3 = { x: 0, y: 0, z: 0 };
const tmpPos: Vec3 = { x: 0, y: 0, z: 0 };

export class ParticleSystem {
  readonly count: number;
  readonly buffers: ParticleBuffers;

  private readonly ages: Float32Array;
  private readonly lifetimes: Float32Array;
  private readonly rng: () => number;
  /** Fractional seeds carried between frames so low flow still emits smoothly. */
  private emitCarryA = 0;
  private emitCarryB = 0;

  constructor(count: number, seed = 0xa4a5e0d1) {
    this.count = count;
    this.rng = makeRng(seed);
    this.buffers = {
      positions: new Float32Array(count * 3),
      velocities: new Float32Array(count * 3),
      speeds: new Float32Array(count),
      origins: new Float32Array(count),
      alphas: new Float32Array(count),
    };
    this.ages = new Float32Array(count);
    this.lifetimes = new Float32Array(count);

    // Start every particle dead and staggered, so the pipes fill rather than
    // appearing fully loaded on the first frame.
    for (let i = 0; i < count; i++) {
      this.ages[i] = -this.rng() * 3.5;
      this.lifetimes[i] = 0;
      this.buffers.alphas[i] = 0;
      this.buffers.positions[i * 3] = -9999;
      this.buffers.velocities[i * 3] = 0;
    }
  }

  /** Place particle i at the mouth of one inlet pipe. */
  private spawn(i: number, fromB: boolean, F: FieldParams): void {
    const port = fromB ? PORT_B : PORT_A;
    const d = port.direction;

    // Uniform-in-area disc sample on the pipe cross-section.
    const r = GEO.pipeRadius * 0.93 * Math.sqrt(this.rng());
    const a = this.rng() * Math.PI * 2;

    // Build an orthonormal basis across the pipe.
    const upX = Math.abs(d.x) < 0.9 ? 1 : 0;
    const upY = Math.abs(d.x) < 0.9 ? 0 : 1;
    let e1x = d.y * 0 - d.z * upY;
    let e1y = d.z * upX - d.x * 0;
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

    // Stagger along the run so the stream looks continuous, not pulsed.
    const along = this.rng() * 0.35;

    const b = i * 3;
    this.buffers.positions[b] = port.origin.x + d.x * along + e1x * ox + e2x * oy;
    this.buffers.positions[b + 1] = port.origin.y + d.y * along + e1y * ox + e2y * oy;
    this.buffers.positions[b + 2] = port.origin.z + d.z * along + e1z * ox + e2z * oy;

    this.buffers.origins[i] = fromB ? 1 : 0;
    this.buffers.alphas[i] = 0;
    this.ages[i] = 0;

    // Give it a velocity straight away. The renderer draws each tracer as a
    // streak along this vector, and a newly spawned particle that reported
    // zero would flash as a dot for one frame before snapping to a streak.
    sampleVelocity(
      tmpVel,
      this.buffers.positions[b],
      this.buffers.positions[b + 1],
      this.buffers.positions[b + 2],
      F,
      fromB ? 1 : 0,
    );
    this.buffers.velocities[b] = tmpVel.x;
    this.buffers.velocities[b + 1] = tmpVel.y;
    this.buffers.velocities[b + 2] = tmpVel.z;
    this.buffers.speeds[i] = F.uOut > 1e-6
      ? Math.hypot(tmpVel.x, tmpVel.y, tmpVel.z) / F.uOut
      : 0;
    // Generous ceiling: a particle caught in a recirculation bubble should be
    // allowed to linger there, because that lingering is the thing to see.
    this.lifetimes[i] = 26 + this.rng() * 18;
  }

  /**
   * Advance one frame.
   *
   * @param dt   Seconds since the last frame, already clamped by the caller.
   * @param F    Field parameters for this instant.
   */
  step(dt: number, F: FieldParams): void {
    const { positions, velocities, speeds, origins, alphas } = this.buffers;

    // Split the emission budget between branches by flow rate, so the visible
    // density of each stream tracks the number the dataset reports.
    const totalU = F.uA + F.uB;
    const fracA = totalU > 1e-6 ? F.uA / totalU : 0.5;

    // Seeding rate is proportional to volumetric flow, which is what injecting
    // tracer dye at a constant concentration would give you. The population in
    // view then stays put as the flow rate changes: faster water clears the
    // pipe sooner, and is replaced sooner by exactly the same amount.
    const transit = 8.5;
    const flowRatio = clamp(F.uOut / NOMINAL_OUTLET_SPEED, 0.12, 3);
    const budget = (this.count / transit) * dt * flowRatio;
    this.emitCarryA += budget * fracA;
    this.emitCarryB += budget * (1 - fracA);

    let toSpawnA = Math.floor(this.emitCarryA);
    let toSpawnB = Math.floor(this.emitCarryB);
    this.emitCarryA -= toSpawnA;
    this.emitCarryB -= toSpawnB;

    // Integration substep cap: a particle must not cross a feature of the
    // field in one step, or the vortex core will alias into a wobble.
    const maxStep = 0.09;

    for (let i = 0; i < this.count; i++) {
      const b = i * 3;
      const age = this.ages[i];

      if (age < 0) {
        // Waiting to enter.
        this.ages[i] = age + dt;
        continue;
      }

      if (this.lifetimes[i] <= 0) {
        // Dead slot: refill it if there is emission budget left.
        if (toSpawnA > 0) {
          this.spawn(i, false, F);
          toSpawnA--;
        } else if (toSpawnB > 0) {
          this.spawn(i, true, F);
          toSpawnB--;
        }
        continue;
      }

      const origin = origins[i];
      let px = positions[b];
      let py = positions[b + 1];
      let pz = positions[b + 2];

      // Substepped midpoint integration. One evaluation would be enough for
      // the straight runs, but the midpoint keeps particles on the spiral
      // instead of letting them drift outward through the vortex.
      let remaining = dt;
      let speed = 0;
      let vx = 0;
      let vy = 0;
      let vz = 0;
      let guard = 0;
      while (remaining > 1e-6 && guard++ < 6) {
        sampleVelocity(tmpVel, px, py, pz, F, origin);
        const v = Math.sqrt(tmpVel.x ** 2 + tmpVel.y ** 2 + tmpVel.z ** 2);
        speed = v;
        const step = Math.min(remaining, v > 1e-6 ? maxStep / v : remaining);

        const hx = px + tmpVel.x * step * 0.5;
        const hy = py + tmpVel.y * step * 0.5;
        const hz = pz + tmpVel.z * step * 0.5;
        sampleVelocity(tmpVel, hx, hy, hz, F, origin);

        vx = tmpVel.x;
        vy = tmpVel.y;
        vz = tmpVel.z;
        px += vx * step;
        py += vy * step;
        pz += vz * step;
        remaining -= step;
      }

      tmpPos.x = px;
      tmpPos.y = py;
      tmpPos.z = pz;
      confine(tmpPos, origin);

      this.ages[i] = age + dt;

      const expired =
        tmpPos.x > OUTLET_END_X ||
        this.ages[i] > this.lifetimes[i] ||
        !Number.isFinite(tmpPos.x);

      if (expired) {
        this.lifetimes[i] = 0;
        alphas[i] = 0;
        positions[b] = -9999;
        continue;
      }

      positions[b] = tmpPos.x;
      positions[b + 1] = tmpPos.y;
      positions[b + 2] = tmpPos.z;
      velocities[b] = vx;
      velocities[b + 1] = vy;
      velocities[b + 2] = vz;
      speeds[i] = F.uOut > 1e-6 ? speed / F.uOut : 0;

      // Fade in over the first stretch, and out as the particle nears the end
      // of the visible run, so the recycle is invisible.
      const fadeIn = Math.min(1, this.ages[i] * 3);
      const tail = Math.min(1, (OUTLET_END_X - tmpPos.x) / 1.2);
      alphas[i] = Math.min(fadeIn, Math.max(tail, 0));
    }
  }
}
