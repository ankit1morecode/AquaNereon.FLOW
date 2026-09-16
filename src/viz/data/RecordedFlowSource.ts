import { clamp } from '../core/math';
import type { FlowDataSource, JunctionCondition } from '../core/types';

/**
 * Capture and replay of junction conditions.
 *
 * This is the bridge between the two halves of the module's life. Run the
 * visualization against a real node, record what came in, and you have a
 * dataset that replays exactly — for a demo with no hardware present, for a
 * bug that only happens on one node, or for showing a stakeholder the event
 * that already happened rather than waiting for the next one.
 *
 * The recording format is the same `JunctionCondition` the rest of the module
 * already speaks, so a recording is interchangeable with a hand-written
 * scenario file.
 */

export interface RecordedFrame {
  /** Seconds from the start of the recording. */
  t: number;
  a: number;
  b: number;
  pA: number;
  pB: number;
  tempA: number;
  tempB: number;
  restriction: number;
  noise: number;
}

export interface Recording {
  id: string;
  label: string;
  /** ISO timestamp of when the capture started. */
  recordedAt: string;
  /** Optional free text — which node, which event, what to look for. */
  note?: string;
  durationSec: number;
  frames: RecordedFrame[];
}

function toFrame(c: JunctionCondition, t: number): RecordedFrame {
  return {
    t: Number(t.toFixed(3)),
    a: Number(c.inletA.flowLps.toFixed(3)),
    b: Number(c.inletB.flowLps.toFixed(3)),
    pA: Number(c.inletA.pressureKpa.toFixed(2)),
    pB: Number(c.inletB.pressureKpa.toFixed(2)),
    tempA: Number(c.inletA.temperatureC.toFixed(2)),
    tempB: Number(c.inletB.temperatureC.toFixed(2)),
    restriction: Number(c.downstreamRestriction.toFixed(4)),
    noise: Number(c.noiseLevel.toFixed(4)),
  };
}

/**
 * Replays a recording, interpolating between frames so playback is smooth at
 * any frame rate regardless of what the capture rate was.
 */
export class RecordedFlowSource implements FlowDataSource {
  readonly id: string;
  readonly label: string;
  readonly durationSec: number;

  constructor(
    private readonly recording: Recording,
    /** Repeat from the start when the recording runs out. */
    readonly loop = true,
  ) {
    this.id = recording.id;
    this.label = recording.label;
    this.durationSec = recording.durationSec;
  }

  get note(): string | undefined {
    return this.recording.note;
  }

  get frameCount(): number {
    return this.recording.frames.length;
  }

  sample(t: number): JunctionCondition {
    const frames = this.recording.frames;
    if (frames.length === 0) {
      return {
        t,
        inletA: { flowLps: 0, pressureKpa: 0, temperatureC: 0 },
        inletB: { flowLps: 0, pressureKpa: 0, temperatureC: 0 },
        downstreamRestriction: 0,
        noiseLevel: 0,
      };
    }

    const span = this.durationSec;
    let tt = t;
    if (this.loop && span > 0) tt = ((t % span) + span) % span;
    tt = clamp(tt, frames[0].t, frames[frames.length - 1].t);

    // Binary search: recordings can be long, and a linear scan every frame
    // would be the most expensive thing in the loop.
    let lo = 0;
    let hi = frames.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (frames[mid].t <= tt) lo = mid;
      else hi = mid;
    }

    const k0 = frames[lo];
    const k1 = frames[hi];
    const dt = k1.t - k0.t;
    const f = dt > 1e-9 ? (tt - k0.t) / dt : 0;
    const mix = (x: number, y: number) => x + (y - x) * f;

    return {
      t,
      inletA: {
        flowLps: mix(k0.a, k1.a),
        pressureKpa: mix(k0.pA, k1.pA),
        temperatureC: mix(k0.tempA, k1.tempA),
      },
      inletB: {
        flowLps: mix(k0.b, k1.b),
        pressureKpa: mix(k0.pB, k1.pB),
        temperatureC: mix(k0.tempB, k1.tempB),
      },
      downstreamRestriction: clamp(mix(k0.restriction, k1.restriction), 0, 1),
      noiseLevel: clamp(mix(k0.noise, k1.noise), 0, 1),
    };
  }
}

/**
 * Captures conditions at a fixed rate into a recording.
 *
 * Bounded by construction: a recorder left running for an afternoon must not
 * be the reason the tab runs out of memory, so it stops at `maxSeconds` and
 * says so rather than growing without limit.
 */
export class FlowRecorder {
  private frames: RecordedFrame[] = [];
  private startedAtSim: number | null = null;
  private accum = 0;
  private startedAtWall = '';

  constructor(
    readonly sampleHz = 10,
    readonly maxSeconds = 600,
  ) {}

  get isRecording(): boolean {
    return this.startedAtSim !== null;
  }

  get frameCount(): number {
    return this.frames.length;
  }

  /** Seconds captured so far. */
  get elapsed(): number {
    return this.frames.length === 0 ? 0 : this.frames[this.frames.length - 1].t;
  }

  get isFull(): boolean {
    return this.elapsed >= this.maxSeconds;
  }

  start(simTime: number): void {
    this.frames = [];
    this.accum = 0;
    this.startedAtSim = simTime;
    this.startedAtWall = new Date().toISOString();
  }

  /** Offer a frame. Recorded only if the sample interval has elapsed. */
  capture(condition: JunctionCondition, simTime: number, dt: number): void {
    if (this.startedAtSim === null || this.isFull) return;
    this.accum += dt;
    if (this.accum < 1 / this.sampleHz) return;
    this.accum = 0;
    this.frames.push(toFrame(condition, simTime - this.startedAtSim));
  }

  /** Finish and return the recording, or null if nothing usable was captured. */
  stop(label = 'Recording', note?: string): Recording | null {
    if (this.startedAtSim === null || this.frames.length < 2) {
      this.startedAtSim = null;
      return null;
    }
    const recording: Recording = {
      id: `REC_${this.startedAtWall.replace(/[^0-9]/g, '').slice(0, 14)}`,
      label,
      recordedAt: this.startedAtWall,
      note,
      durationSec: this.frames[this.frames.length - 1].t,
      frames: this.frames,
    };
    this.startedAtSim = null;
    this.frames = [];
    return recording;
  }

  cancel(): void {
    this.startedAtSim = null;
    this.frames = [];
  }
}

/** Serialise a recording to the same JSON shape the scenario files use. */
export function recordingToJson(recording: Recording): string {
  return JSON.stringify(recording, null, 2);
}

/**
 * Parse a recording, validating the parts the replay actually depends on.
 * Returns null rather than throwing, because the input is a user-chosen file.
 */
export function recordingFromJson(text: string): Recording | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const r = parsed as Partial<Recording>;
  if (!Array.isArray(r.frames) || r.frames.length < 2) return null;

  const frames: RecordedFrame[] = [];
  for (const raw of r.frames) {
    if (typeof raw !== 'object' || raw === null) return null;
    const f = raw as Partial<RecordedFrame>;
    if (typeof f.t !== 'number' || typeof f.a !== 'number' || typeof f.b !== 'number') {
      return null;
    }
    frames.push({
      t: f.t,
      a: f.a,
      b: f.b,
      pA: f.pA ?? 0,
      pB: f.pB ?? 0,
      tempA: f.tempA ?? 0,
      tempB: f.tempB ?? 0,
      restriction: f.restriction ?? 0,
      noise: f.noise ?? 0.12,
    });
  }
  // Replay binary-searches on t, which requires the frames to be ordered.
  frames.sort((x, y) => x.t - y.t);

  return {
    id: r.id ?? 'RECORDING',
    label: r.label ?? 'Recording',
    recordedAt: r.recordedAt ?? new Date(0).toISOString(),
    note: r.note,
    durationSec: r.durationSec ?? frames[frames.length - 1].t,
    frames,
  };
}
