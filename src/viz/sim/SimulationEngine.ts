import { deriveFieldParams } from '../core/fieldParams';
import { analyseRing, sampleRing, CHANNEL_COUNT } from '../core/sensorRing';
import {
  buildSignature,
  captureBaseline,
  scoreFrame,
  PERSISTENCE_TAU,
  type Baseline,
} from '../core/baseline';
import type {
  FieldParams,
  FlowDataSource,
  FlowSignature,
  JunctionCondition,
} from '../core/types';
import { BASELINE_CONDITION } from '../data/SyntheticFlowSource';
import { ParticleSystem } from './ParticleSystem';
import { SignatureHistory } from './SignatureHistory';
import { StreamlineSet } from './Streamlines';

/**
 * The one object that owns the running simulation.
 *
 * Its job is to keep the chain in the right order, once per frame:
 *
 *     data source -> junction condition -> field parameters
 *                 -> particles + streamlines   (what the water does)
 *                 -> sensor ring               (what the hardware sees)
 *                 -> baseline comparison       (what that pattern means)
 *                 -> history                   (whether it is developing)
 *
 * Nothing in this class knows whether the condition came from a JSON file or
 * from a live node, and nothing in the React layer knows how any of it works.
 */

export interface SimulationOptions {
  particleCount: number;
  streamlineCount: number;
}

/** Largest real-time step accepted, before playback scaling. */
const MAX_FRAME_DT = 1 / 20;
/** Largest simulated step accepted, after playback scaling. */
const MAX_SIM_DT = 1 / 12;

/** Named tracer budgets, offered in the UI. */
export const QUALITY_LEVELS = {
  low: 5000,
  medium: 11000,
  high: 18000,
} as const;

export type QualityLevel = keyof typeof QUALITY_LEVELS;

export class SimulationEngine {
  particles: ParticleSystem;
  readonly streamlines: StreamlineSet;
  readonly history = new SignatureHistory();
  readonly baseline: Baseline;

  /** Simulated seconds since the run started, excluding paused time. */
  time = 0;
  /** Playback rate. 1 = real time. */
  timeScale = 1;

  condition: JunctionCondition;
  field: FieldParams;
  signature: FlowSignature;

  private source: FlowDataSource;
  private readonly channels = new Float32Array(CHANNEL_COUNT);
  /** Time-filtered baseline deviation. See PERSISTENCE_TAU. */
  private persistedDistance = 0;

  constructor(source: FlowDataSource, options: SimulationOptions) {
    this.source = source;
    this.particles = new ParticleSystem(options.particleCount);
    this.streamlines = new StreamlineSet(options.streamlineCount);

    // Capture the reference pattern before anything else runs, from a known
    // balanced condition. Everything the ring reports later is measured
    // against this rather than against a fixed threshold.
    this.baseline = captureBaseline('balanced-12-12', BASELINE_CONDITION);

    this.condition = this.source.sample(0);
    this.field = deriveFieldParams(this.condition, 0);
    sampleRing(this.field, this.condition.noiseLevel, this.channels);
    const frame = analyseRing(this.channels);
    this.persistedDistance = scoreFrame(frame, this.baseline);
    this.signature = buildSignature(
      frame,
      this.field.swirlNumber,
      this.persistedDistance,
      'STABLE',
    );
    this.streamlines.rebuild(this.field);
  }

  setSource(source: FlowDataSource, resetTime = true): void {
    this.source = source;
    if (resetTime) {
      this.time = 0;
      this.history.clear();
    }
    this.refresh();
  }

  getSource(): FlowDataSource {
    return this.source;
  }

  /**
   * Jump to a point in the dataset.
   *
   * Particles are deliberately left where they are: the water does not
   * teleport just because the boundary condition did, and watching the field
   * drag it into the new state is more informative than a hard cut.
   */
  seek(time: number): void {
    this.time = Math.max(0, time);
    this.history.clear();
    this.refresh();
  }

  /** Replace the tracer population, e.g. when the quality setting changes. */
  setParticleCount(count: number): void {
    if (count === this.particles.count) return;
    this.particles = new ParticleSystem(count);
  }

  /**
   * Re-derive everything from the source at the current time without
   * advancing it. Used after a seek or a source change, so the panels and the
   * streamlines are never a frame behind the condition they describe.
   */
  private refresh(): void {
    this.condition = this.source.sample(this.time);
    this.field = deriveFieldParams(this.condition, this.time);
    sampleRing(this.field, this.condition.noiseLevel, this.channels);
    const frame = analyseRing(this.channels);
    this.persistedDistance = scoreFrame(frame, this.baseline);
    this.signature = buildSignature(
      frame,
      this.field.swirlNumber,
      this.persistedDistance,
      this.signature?.state ?? 'STABLE',
    );
    this.streamlines.rebuild(this.field);
  }

  /**
   * Advance one frame.
   *
   * @param rawDt Seconds of wall-clock time. Clamped twice — once before the
   *              playback scaling and once after — because a backgrounded tab
   *              returns a multi-second delta, and one huge step would fling
   *              every particle through the pipe wall.
   */
  step(rawDt: number): void {
    const wall = Math.min(Math.max(rawDt, 0), MAX_FRAME_DT);
    const dt = Math.min(wall * this.timeScale, MAX_SIM_DT);
    if (dt <= 0) return;

    this.time += dt;

    this.condition = this.source.sample(this.time);
    this.field = deriveFieldParams(this.condition, this.time);

    this.particles.step(dt, this.field);
    this.streamlines.update(this.field, 3);

    sampleRing(this.field, this.condition.noiseLevel, this.channels);
    const frame = analyseRing(this.channels);

    // Exponential persistence filter, framerate-independent.
    const instant = scoreFrame(frame, this.baseline);
    const alpha = 1 - Math.exp(-dt / PERSISTENCE_TAU);
    this.persistedDistance += (instant - this.persistedDistance) * alpha;

    this.signature = buildSignature(
      frame,
      this.field.swirlNumber,
      this.persistedDistance,
      this.signature.state,
    );

    this.history.record(this.signature, this.time, dt);
  }
}

/**
 * Pick a particle budget the machine can actually sustain. Advection is a CPU
 * cost, so this keys off core count rather than off the GPU.
 */
export function suggestParticleCount(): number {
  const cores =
    typeof navigator === 'undefined' ? 4 : (navigator.hardwareConcurrency ?? 4);
  if (cores <= 2) return QUALITY_LEVELS.low;
  if (cores <= 8) return QUALITY_LEVELS.medium;
  return QUALITY_LEVELS.high;
}

export function nearestQuality(count: number): QualityLevel {
  let best: QualityLevel = 'medium';
  let bestDelta = Infinity;
  for (const key of Object.keys(QUALITY_LEVELS) as QualityLevel[]) {
    const delta = Math.abs(QUALITY_LEVELS[key] - count);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = key;
    }
  }
  return best;
}
