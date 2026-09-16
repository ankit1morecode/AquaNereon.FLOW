import { clamp } from '../core/math';
import type { FlowDataSource, JunctionCondition } from '../core/types';

/**
 * Live telemetry from a real AquaNereon node.
 *
 * This is the whole cost of retiring the synthetic data: one class with one
 * method that matters. Nothing in `core/`, `sim/`, `scene/` or `ui/` imports a
 * scenario, so
 *
 *     <JunctionFlow3D source={liveSource} />
 *
 * is the entire change.
 *
 * Feed it with `push()` from whatever transport the platform settles on — the
 * MQTT topic the edge processor publishes to, a websocket relay from the
 * FastAPI backend, or a polling fetch against the telemetry endpoint. See
 * `WebSocketFlowSource` below for a working one.
 */
export class LiveSensorSource implements FlowDataSource {
  readonly id: string = 'LIVE';
  readonly durationSec = null;

  protected latest: JunctionCondition | null = null;
  protected latestAt = 0;
  protected receivedCount = 0;

  constructor(
    readonly label = 'Live node',
    /** Seconds after which the feed is treated as stale. */
    protected readonly staleAfterSec = 5,
  ) {}

  /** Call on every inbound telemetry frame. */
  push(condition: JunctionCondition, receivedAtSec: number): void {
    this.latest = condition;
    this.latestAt = receivedAtSec;
    this.receivedCount++;
  }

  get framesReceived(): number {
    return this.receivedCount;
  }

  hasData(): boolean {
    return this.latest !== null;
  }

  isStale(now: number): boolean {
    return this.latest === null || now - this.latestAt > this.staleAfterSec;
  }

  sample(t: number): JunctionCondition {
    if (this.isStale(t)) {
      // An absent feed must not be drawn as a healthy one. Returning zero flow
      // stops the water rather than freezing the last good frame, which would
      // look like a working node reporting a steady condition.
      return {
        t,
        inletA: { flowLps: 0, pressureKpa: 0, temperatureC: 0 },
        inletB: { flowLps: 0, pressureKpa: 0, temperatureC: 0 },
        downstreamRestriction: 0,
        noiseLevel: 0,
      };
    }
    return { ...this.latest!, t };
  }
}

/* ================================================================== */
/* Transport                                                           */
/* ================================================================== */

/**
 * Translates one inbound message into a junction condition.
 *
 * Kept as a caller-supplied function because the wire format is the backend's
 * business, not the visualization's. Return null to ignore a message — a
 * heartbeat, an ack, a frame from another node.
 */
export type TelemetryMapper = (message: unknown) => JunctionCondition | null;

/**
 * The default mapper, for a payload shaped like the AquaNereonNode telemetry
 * contract in the software dossier:
 *
 *     { node_id, timestamp, telemetry: { flow: { a, b }, pressure: {...} } }
 *
 * It is deliberately forgiving about which of the several plausible spellings
 * a backend ends up using, and strict about the one thing that matters: a
 * message with no usable flow reading is not a condition and is dropped.
 */
export function defaultTelemetryMapper(message: unknown): JunctionCondition | null {
  if (typeof message !== 'object' || message === null) return null;
  const m = message as Record<string, unknown>;
  const t = (m.telemetry ?? m) as Record<string, unknown>;

  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;

  const flow = (t.flow ?? {}) as Record<string, unknown>;
  const pressure = (t.pressure ?? {}) as Record<string, unknown>;
  const temperature = (t.temperature ?? {}) as Record<string, unknown>;

  const flowA = num(flow.a) ?? num(flow.inlet_a) ?? num(t.flow_a);
  const flowB = num(flow.b) ?? num(flow.inlet_b) ?? num(t.flow_b);
  if (flowA === null || flowB === null) return null;

  return {
    t: num(m.timestamp) ?? 0,
    inletA: {
      flowLps: Math.max(flowA, 0),
      pressureKpa: num(pressure.a) ?? num(t.pressure_a) ?? 0,
      temperatureC: num(temperature.a) ?? num(t.temperature) ?? 0,
    },
    inletB: {
      flowLps: Math.max(flowB, 0),
      pressureKpa: num(pressure.b) ?? num(t.pressure_b) ?? 0,
      temperatureC: num(temperature.b) ?? num(t.temperature) ?? 0,
    },
    downstreamRestriction: clamp(
      num(t.downstream_restriction) ?? num(t.valve_state) ?? 0,
      0,
      1,
    ),
    noiseLevel: clamp(num(t.noise_level) ?? num(t.data_quality_noise) ?? 0.12, 0, 1),
  };
}

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

export interface WebSocketFlowSourceOptions {
  label?: string;
  /** Wire-format translator. Defaults to the dossier's telemetry shape. */
  mapper?: TelemetryMapper;
  /** Seconds without a frame before the feed counts as stale. */
  staleAfterSec?: number;
  /** Reconnect backoff bounds, milliseconds. */
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /** Injectable for tests; defaults to the global WebSocket. */
  socketFactory?: (url: string) => WebSocket;
  /** Injectable clock, seconds. Defaults to performance.now()/1000. */
  now?: () => number;
}

/**
 * A LiveSensorSource fed by a websocket, with reconnect.
 *
 * The visualization must survive a backend that comes and goes — a demo
 * machine sleeping, an edge node rebooting, a relay restarting — without being
 * remounted, because remounting would throw away the baseline and the history.
 * So the socket reconnects with exponential backoff underneath a source object
 * whose identity never changes.
 */
export class WebSocketFlowSource extends LiveSensorSource {
  readonly id: string = 'LIVE_WS';

  private socket: WebSocket | null = null;
  private readonly mapper: TelemetryMapper;
  private readonly socketFactory: (url: string) => WebSocket;
  private readonly now: () => number;
  private readonly reconnectMinMs: number;
  private readonly reconnectMaxMs: number;
  private reconnectDelay: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  connection: ConnectionState = 'idle';
  lastError: string | null = null;

  constructor(
    readonly url: string,
    options: WebSocketFlowSourceOptions = {},
  ) {
    super(options.label ?? 'Live node', options.staleAfterSec ?? 5);
    this.mapper = options.mapper ?? defaultTelemetryMapper;
    this.socketFactory = options.socketFactory ?? ((u) => new WebSocket(u));
    this.now = options.now ?? (() => performance.now() / 1000);
    this.reconnectMinMs = options.reconnectMinMs ?? 500;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 15000;
    this.reconnectDelay = this.reconnectMinMs;
  }

  connect(): void {
    if (this.disposed || this.socket) return;
    this.connection = 'connecting';
    try {
      const socket = this.socketFactory(this.url);
      this.socket = socket;

      socket.onopen = () => {
        this.connection = 'open';
        this.lastError = null;
        this.reconnectDelay = this.reconnectMinMs;
      };

      socket.onmessage = (event: MessageEvent) => {
        let payload: unknown;
        try {
          payload = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        } catch {
          // A malformed frame is a bad frame, not a broken feed. Drop it and
          // let staleness handle a feed that only ever sends bad frames.
          return;
        }
        const condition = this.mapper(payload);
        if (condition) this.push(condition, this.now());
      };

      socket.onerror = () => {
        this.connection = 'error';
        this.lastError = 'socket error';
      };

      socket.onclose = () => {
        this.socket = null;
        if (this.disposed) return;
        this.connection = 'closed';
        this.scheduleReconnect();
      };
    } catch (err) {
      this.socket = null;
      this.connection = 'error';
      this.lastError = err instanceof Error ? err.message : String(err);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(delay * 2, this.reconnectMaxMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /** Close the socket and stop reconnecting. Safe to call more than once. */
  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onerror = null;
      this.socket.onclose = null;
      this.socket.close();
      this.socket = null;
    }
    this.connection = 'closed';
  }
}
