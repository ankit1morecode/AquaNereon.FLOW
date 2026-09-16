import { describe, expect, it, vi } from 'vitest';
import {
  defaultTelemetryMapper,
  LiveSensorSource,
  WebSocketFlowSource,
} from '../src/viz/data/LiveSensorSource';
import {
  FlowRecorder,
  RecordedFlowSource,
  recordingFromJson,
  recordingToJson,
  type Recording,
} from '../src/viz/data/RecordedFlowSource';
import type { JunctionCondition } from '../src/viz/core/types';

/**
 * Tests for the replacement seam.
 *
 * The module's central architectural claim is that swapping synthetic data for
 * real telemetry costs one class. These check that the contract actually holds
 * at the boundary: that a live feed degrades safely, that a malformed frame
 * cannot poison the scene, and that a recording round-trips.
 */

function condition(a: number, b: number, t = 0): JunctionCondition {
  return {
    t,
    inletA: { flowLps: a, pressureKpa: 310, temperatureC: 21 },
    inletB: { flowLps: b, pressureKpa: 305, temperatureC: 21 },
    downstreamRestriction: 0.1,
    noiseLevel: 0.2,
  };
}

describe('LiveSensorSource', () => {
  it('reports zero flow before any frame arrives', () => {
    const source = new LiveSensorSource();
    expect(source.hasData()).toBe(false);
    const c = source.sample(0);
    expect(c.inletA.flowLps).toBe(0);
    expect(c.inletB.flowLps).toBe(0);
  });

  it('returns the newest frame while it is fresh', () => {
    const source = new LiveSensorSource('node', 5);
    source.push(condition(13, 11), 10);
    const c = source.sample(12);
    expect(c.inletA.flowLps).toBe(13);
    expect(c.t).toBe(12);
  });

  it('goes to zero rather than freezing when the feed goes stale', () => {
    // A frozen last-good frame would look like a healthy node reporting a
    // steady condition, which is the one thing a stale feed must not look like.
    const source = new LiveSensorSource('node', 5);
    source.push(condition(13, 11), 10);
    expect(source.sample(20).inletA.flowLps).toBe(0);
    expect(source.isStale(20)).toBe(true);
  });

  it('recovers when frames resume', () => {
    const source = new LiveSensorSource('node', 5);
    source.push(condition(13, 11), 10);
    expect(source.sample(20).inletA.flowLps).toBe(0);
    source.push(condition(9, 9), 21);
    expect(source.sample(22).inletA.flowLps).toBe(9);
  });

  it('has no duration, so the transport shows a live indicator', () => {
    expect(new LiveSensorSource().durationSec).toBeNull();
  });
});

describe('defaultTelemetryMapper', () => {
  it('reads the nested telemetry shape from the dossier', () => {
    const c = defaultTelemetryMapper({
      node_id: 'AN-J-014',
      timestamp: 42,
      telemetry: {
        flow: { a: 12.5, b: 9.5 },
        pressure: { a: 311, b: 288 },
        temperature: { a: 21.2, b: 21.0 },
        valve_state: 0.3,
      },
    });
    expect(c).not.toBeNull();
    expect(c!.inletA.flowLps).toBe(12.5);
    expect(c!.inletB.pressureKpa).toBe(288);
    expect(c!.downstreamRestriction).toBeCloseTo(0.3, 6);
    expect(c!.t).toBe(42);
  });

  it('accepts a flat payload too', () => {
    const c = defaultTelemetryMapper({ flow_a: 8, flow_b: 7 });
    expect(c!.inletA.flowLps).toBe(8);
    expect(c!.inletB.flowLps).toBe(7);
  });

  it('rejects a message with no usable flow reading', () => {
    expect(defaultTelemetryMapper({ telemetry: { pressure: { a: 300 } } })).toBeNull();
    expect(defaultTelemetryMapper({ hello: 'world' })).toBeNull();
    expect(defaultTelemetryMapper(null)).toBeNull();
    expect(defaultTelemetryMapper('not an object')).toBeNull();
  });

  it('rejects non-finite readings rather than passing NaN into the field', () => {
    expect(defaultTelemetryMapper({ flow_a: NaN, flow_b: 7 })).toBeNull();
    expect(defaultTelemetryMapper({ flow_a: Infinity, flow_b: 7 })).toBeNull();
  });

  it('clamps a restriction outside 0..1', () => {
    const c = defaultTelemetryMapper({ flow_a: 8, flow_b: 7, valve_state: 4 });
    expect(c!.downstreamRestriction).toBe(1);
  });

  it('never reports negative flow', () => {
    const c = defaultTelemetryMapper({ flow_a: -3, flow_b: 7 });
    expect(c!.inletA.flowLps).toBe(0);
  });
});

/** Minimal stand-in for a browser WebSocket. */
class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;

  close(): void {
    this.closed = true;
    this.onclose?.();
  }

  emit(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }

  emitRaw(data: string): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

describe('WebSocketFlowSource', () => {
  const build = () => {
    const sockets: FakeSocket[] = [];
    let clock = 0;
    const source = new WebSocketFlowSource('ws://localhost/telemetry', {
      socketFactory: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s as unknown as WebSocket;
      },
      now: () => clock,
      reconnectMinMs: 10,
      reconnectMaxMs: 40,
    });
    return { source, sockets, tick: (t: number) => (clock = t) };
  };

  it('takes frames off the wire', () => {
    const { source, sockets, tick } = build();
    source.connect();
    sockets[0].onopen?.();
    expect(source.connection).toBe('open');

    tick(5);
    sockets[0].emit({ flow_a: 14, flow_b: 10 });
    expect(source.framesReceived).toBe(1);
    expect(source.sample(5).inletA.flowLps).toBe(14);
    source.dispose();
  });

  it('drops malformed frames without breaking the feed', () => {
    const { source, sockets, tick } = build();
    source.connect();
    sockets[0].onopen?.();

    tick(1);
    sockets[0].emitRaw('{not json');
    sockets[0].emit({ nothing: 'useful' });
    expect(source.framesReceived).toBe(0);

    sockets[0].emit({ flow_a: 11, flow_b: 11 });
    expect(source.framesReceived).toBe(1);
    source.dispose();
  });

  it('reconnects with backoff after the socket closes', () => {
    vi.useFakeTimers();
    const { source, sockets } = build();
    source.connect();
    sockets[0].onopen?.();
    sockets[0].close();
    expect(source.connection).toBe('closed');

    vi.advanceTimersByTime(15);
    expect(sockets).toHaveLength(2);

    // Second failure should wait longer than the first.
    sockets[1].close();
    vi.advanceTimersByTime(15);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(15);
    expect(sockets).toHaveLength(3);

    source.dispose();
    vi.useRealTimers();
  });

  it('stops reconnecting once disposed', () => {
    vi.useFakeTimers();
    const { source, sockets } = build();
    source.connect();
    source.dispose();
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(1);
    expect(sockets[0].closed).toBe(true);
    vi.useRealTimers();
  });

  it('survives a socket constructor that throws', () => {
    vi.useFakeTimers();
    const source = new WebSocketFlowSource('ws://nope', {
      socketFactory: () => {
        throw new Error('refused');
      },
      reconnectMinMs: 10,
    });
    expect(() => source.connect()).not.toThrow();
    expect(source.connection).toBe('error');
    expect(source.lastError).toBe('refused');
    source.dispose();
    vi.useRealTimers();
  });
});

describe('recording round trip', () => {
  const capture = (): Recording => {
    const recorder = new FlowRecorder(10, 600);
    recorder.start(0);
    for (let i = 0; i < 60; i++) {
      const t = i * 0.1;
      recorder.capture(condition(12 + Math.sin(t), 12 - Math.sin(t), t), t, 0.1);
    }
    const rec = recorder.stop('test capture', 'a note');
    if (!rec) throw new Error('recorder produced nothing');
    return rec;
  };

  it('captures at the configured rate', () => {
    const rec = capture();
    expect(rec.frames.length).toBeGreaterThan(50);
    expect(rec.durationSec).toBeGreaterThan(5);
    expect(rec.note).toBe('a note');
  });

  it('refuses to produce a recording from too few frames', () => {
    const recorder = new FlowRecorder(10);
    recorder.start(0);
    recorder.capture(condition(12, 12), 0.1, 0.1);
    expect(recorder.stop()).toBeNull();
  });

  it('ignores captures when not recording', () => {
    const recorder = new FlowRecorder(10);
    recorder.capture(condition(12, 12), 0, 0.1);
    expect(recorder.frameCount).toBe(0);
  });

  it('stops growing at the cap', () => {
    const recorder = new FlowRecorder(10, 1);
    recorder.start(0);
    for (let i = 0; i < 200; i++) recorder.capture(condition(12, 12, i * 0.1), i * 0.1, 0.1);
    expect(recorder.isFull).toBe(true);
    expect(recorder.frameCount).toBeLessThan(20);
  });

  it('survives JSON and replays the same values', () => {
    const rec = capture();
    const parsed = recordingFromJson(recordingToJson(rec));
    expect(parsed).not.toBeNull();

    const original = new RecordedFlowSource(rec);
    const replayed = new RecordedFlowSource(parsed!);
    for (const t of [0.35, 1.2, 3.7, 5.0]) {
      expect(replayed.sample(t).inletA.flowLps).toBeCloseTo(
        original.sample(t).inletA.flowLps,
        5,
      );
    }
  });

  it('rejects malformed JSON rather than throwing', () => {
    expect(recordingFromJson('{nope')).toBeNull();
    expect(recordingFromJson('{"frames":[]}')).toBeNull();
    expect(recordingFromJson('{"frames":[{"t":0}]}')).toBeNull();
    expect(recordingFromJson('null')).toBeNull();
  });

  it('interpolates between captured frames', () => {
    const rec = capture();
    const source = new RecordedFlowSource(rec);
    const a = source.sample(1.0).inletA.flowLps;
    const b = source.sample(1.05).inletA.flowLps;
    expect(a).not.toBe(b);
    expect(Math.abs(a - b)).toBeLessThan(0.2);
  });

  it('loops by default and clamps when it does not', () => {
    const rec = capture();
    const looping = new RecordedFlowSource(rec, true);
    expect(looping.sample(1).inletA.flowLps).toBeCloseTo(
      looping.sample(1 + rec.durationSec).inletA.flowLps,
      4,
    );

    const once = new RecordedFlowSource(rec, false);
    const past = once.sample(rec.durationSec + 50).inletA.flowLps;
    const last = once.sample(rec.durationSec).inletA.flowLps;
    expect(past).toBeCloseTo(last, 5);
  });

  it('sorts out-of-order frames on load, since replay binary-searches', () => {
    const shuffled = JSON.stringify({
      frames: [
        { t: 2, a: 3, b: 3 },
        { t: 0, a: 1, b: 1 },
        { t: 1, a: 2, b: 2 },
      ],
    });
    const parsed = recordingFromJson(shuffled);
    expect(parsed!.frames.map((f) => f.t)).toEqual([0, 1, 2]);
    expect(new RecordedFlowSource(parsed!).sample(1).inletA.flowLps).toBeCloseTo(2, 5);
  });

  it('handles an empty recording without producing NaN', () => {
    const source = new RecordedFlowSource({
      id: 'x',
      label: 'x',
      recordedAt: '',
      durationSec: 0,
      frames: [],
    });
    const c = source.sample(3);
    expect(c.inletA.flowLps).toBe(0);
    expect(Number.isFinite(c.noiseLevel)).toBe(true);
  });
});
