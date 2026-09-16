import { CHANNEL_COUNT } from '../core/sensorRing';
import type { FlowSignature, FlowState } from '../core/types';

/**
 * Rolling history of what the sensor ring has reported.
 *
 * The dossier's temporal feature group — rate of change, persistence, drift —
 * only means anything against a record of past frames, and drift in particular
 * is invisible in any single frame. This keeps a fixed-size ring of recent
 * channel readings so the pattern can be shown evolving rather than as a
 * snapshot that the viewer has to remember.
 *
 * Fixed-capacity and allocation-free after construction: it is written every
 * frame for as long as the page is open.
 */

/** Samples retained, and the rate they are taken at. */
export const HISTORY_HZ = 20;
export const HISTORY_SECONDS = 30;
const CAPACITY = HISTORY_HZ * HISTORY_SECONDS;

const STATE_CODES: Record<FlowState, number> = {
  STABLE: 0,
  DRIFT: 1,
  PRE_DISTURBANCE: 2,
  DISTURBANCE: 3,
};

const STATE_BY_CODE: FlowState[] = ['STABLE', 'DRIFT', 'PRE_DISTURBANCE', 'DISTURBANCE'];

export class SignatureHistory {
  readonly capacity = CAPACITY;
  readonly channels = CHANNEL_COUNT;

  /** Channel distributions, flattened: sample-major, CHANNEL_COUNT per sample. */
  private readonly distributions = new Float32Array(CAPACITY * CHANNEL_COUNT);
  private readonly distances = new Float32Array(CAPACITY);
  private readonly states = new Uint8Array(CAPACITY);
  private readonly times = new Float32Array(CAPACITY);

  /** Index the next sample will be written to. */
  private head = 0;
  /** Number of valid samples, up to capacity. */
  private filled = 0;
  private accum = 0;

  /** Offer a frame; it is recorded only if the sample interval has elapsed. */
  record(signature: FlowSignature, time: number, dt: number): boolean {
    this.accum += dt;
    if (this.accum < 1 / HISTORY_HZ) return false;
    this.accum = 0;

    const base = this.head * CHANNEL_COUNT;
    for (let i = 0; i < CHANNEL_COUNT; i++) {
      this.distributions[base + i] = signature.distribution[i];
    }
    this.distances[this.head] = signature.baselineDistance;
    this.states[this.head] = STATE_CODES[signature.state];
    this.times[this.head] = time;

    this.head = (this.head + 1) % CAPACITY;
    if (this.filled < CAPACITY) this.filled++;
    return true;
  }

  clear(): void {
    this.head = 0;
    this.filled = 0;
    this.accum = 0;
  }

  get length(): number {
    return this.filled;
  }

  /**
   * Map a chronological index (0 = oldest retained) to its slot in the ring.
   * Callers read through this rather than touching the buffers directly.
   */
  private slot(index: number): number {
    const start = this.filled < CAPACITY ? 0 : this.head;
    return (start + index) % CAPACITY;
  }

  /** Channel value at chronological `index`, channel `channel`. */
  channelAt(index: number, channel: number): number {
    return this.distributions[this.slot(index) * CHANNEL_COUNT + channel];
  }

  distanceAt(index: number): number {
    return this.distances[this.slot(index)];
  }

  stateAt(index: number): FlowState {
    return STATE_BY_CODE[this.states[this.slot(index)]];
  }

  timeAt(index: number): number {
    return this.times[this.slot(index)];
  }

  /**
   * Rate of change of the baseline distance over the last `seconds`, per
   * second. This is the dossier's temporal "rate of change" feature, and it is
   * what separates a junction that has settled into a new steady state from
   * one that is still moving away from its baseline.
   */
  distanceSlope(seconds = 4): number {
    if (this.filled < 4) return 0;
    const span = Math.min(Math.round(seconds * HISTORY_HZ), this.filled);
    const first = this.filled - span;

    // Least-squares slope over the window.
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    for (let k = 0; k < span; k++) {
      const x = k / HISTORY_HZ;
      const y = this.distanceAt(first + k);
      sx += x;
      sy += y;
      sxx += x * x;
      sxy += x * y;
    }
    const denom = span * sxx - sx * sx;
    return Math.abs(denom) < 1e-9 ? 0 : (span * sxy - sx * sy) / denom;
  }

  /**
   * Fraction of the last `seconds` spent at or above DRIFT. The dossier calls
   * this persistence, and it is the difference between a transient that came
   * and went and a condition that is actually developing.
   */
  persistence(seconds = 8): number {
    if (this.filled === 0) return 0;
    const span = Math.min(Math.round(seconds * HISTORY_HZ), this.filled);
    const first = this.filled - span;
    let count = 0;
    for (let k = 0; k < span; k++) {
      if (this.states[this.slot(first + k)] >= 1) count++;
    }
    return count / span;
  }
}
