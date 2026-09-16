import type {
  AquaNereonNode,
  CityOverview,
  CommandAck,
  ConfigCommand,
  DemandForecast,
  DiagnosticsCommand,
  EventQuery,
  FlowSignature,
  ForecastQuery,
  NetworkGraph,
  NodeHealth,
  NodeId,
  NodeState,
  NodeSummary,
  Page,
  RawWindowCommand,
  Recommendation,
  SamplingCommand,
  TelemetryFrame,
  TelemetryQuery,
  WaterEvent,
  ZoneId,
  ZoneSummary,
} from '../types';
import { ApiError, type ApiClient } from './client';

/**
 * The real platform API, endpoint for endpoint as specified in dossier §23.
 *
 * Nothing here is clever. It exists so that the day the FastAPI backend is up,
 * swapping `SimulatedApiClient` for this one is a one-line change in the
 * provider, and every page keeps working because both satisfy `ApiClient`.
 *
 * Change notification is polling, because REST has no push. If the backend
 * grows a websocket or SSE stream, replace `subscribe` here and nothing above
 * it needs to know.
 */

export interface HttpApiClientOptions {
  baseUrl?: string;
  /** Poll interval in ms for the subscribe() change signal. */
  pollMs?: number;
  /** Extra headers, e.g. an auth token. */
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export class HttpApiClient implements ApiClient {
  readonly mode = 'REAL' as const;
  readonly label: string;

  private readonly baseUrl: string;
  private readonly pollMs: number;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: HttpApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '/api/v1').replace(/\/$/, '');
    this.pollMs = options.pollMs ?? 4000;
    this.headers = { 'content-type': 'application/json', ...options.headers };
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.label = `Live backend · ${this.baseUrl}`;
  }

  private async request<T>(
    path: string,
    init?: RequestInit & { query?: Record<string, unknown> },
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`, globalThis.location?.origin ?? 'http://localhost');
    if (init?.query) {
      for (const [key, value] of Object.entries(init.query)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
    }

    const response = await this.fetchImpl(url.toString(), {
      ...init,
      headers: { ...this.headers, ...(init?.headers as Record<string, string>) },
    });

    if (!response.ok) {
      let detail = response.statusText;
      try {
        detail = (await response.text()) || detail;
      } catch {
        // A body that will not read is not more informative than the status.
      }
      throw new ApiError(response.status, path, detail);
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: 'POST', body: JSON.stringify(body) });
  }

  /* ---- 23.1 device telemetry ---- */
  postTelemetry = (frame: TelemetryFrame) => this.post<void>('/telemetry', frame);
  postFlowSignature = (s: FlowSignature) => this.post<void>('/flow-signatures', s);
  postHealth = (h: NodeHealth) => this.post<void>('/health', h);
  postEvent = (e: WaterEvent) => this.post<void>('/events', e);

  /* ---- 23.2 query ---- */
  getNodes = () => this.request<NodeSummary[]>('/nodes');
  getNode = (id: NodeId) => this.request<AquaNereonNode>(`/nodes/${encodeURIComponent(id)}`);

  getNodeTelemetry = (id: NodeId, query?: TelemetryQuery) =>
    this.request<TelemetryFrame[]>(`/nodes/${encodeURIComponent(id)}/telemetry`, {
      query: query as Record<string, unknown>,
    });

  getNodeSignature = (id: NodeId) =>
    this.request<FlowSignature>(`/nodes/${encodeURIComponent(id)}/signature`);

  getNodeSignatureHistory = (id: NodeId, limit = 60) =>
    this.request<FlowSignature[]>(`/nodes/${encodeURIComponent(id)}/signature`, {
      query: { history: true, limit },
    });

  getNodeState = (id: NodeId) =>
    this.request<NodeState>(`/nodes/${encodeURIComponent(id)}/state`);

  getNodeHealth = (id: NodeId) =>
    this.request<NodeHealth>(`/nodes/${encodeURIComponent(id)}/health`);

  getZoneSummary = (id: ZoneId) =>
    this.request<ZoneSummary>(`/zones/${encodeURIComponent(id)}/summary`);

  /** No collection endpoint is specified for zones, so fan out over the graph. */
  async getZones(): Promise<ZoneSummary[]> {
    const network = await this.getNetwork();
    return Promise.all(network.zones.map((z) => this.getZoneSummary(z.zone_id)));
  }

  getEvents = (query?: EventQuery) =>
    this.request<Page<WaterEvent>>('/events', { query: query as Record<string, unknown> });

  getForecasts = (query?: ForecastQuery) =>
    this.request<DemandForecast[]>('/forecasts', { query: query as Record<string, unknown> });

  getRecommendations = () => this.request<Recommendation[]>('/recommendations');
  getNetwork = () => this.request<NetworkGraph>('/network');

  /** Not in §23; derived here so the City screen works against either client. */
  async getCityOverview(): Promise<CityOverview> {
    const [nodes, zones, events] = await Promise.all([
      this.getNodes(),
      this.getZones(),
      this.getEvents({ limit: 200 }),
    ]);
    const byState = { STABLE: 0, DRIFT: 0, PRE_DISTURBANCE: 0, DISTURBANCE: 0 };
    for (const node of nodes) byState[node.state]++;
    const open = events.items.filter((e) => e.status !== 'CLOSED');
    const order = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
    return {
      timestamp: new Date().toISOString(),
      supply_lps: nodes.reduce((s, n) => s + n.flow_lps, 0),
      demand_lps: zones.reduce((s, z) => s + z.demand_lps, 0),
      reservoir_fraction: 0,
      nodes_total: nodes.length,
      nodes_by_state: byState,
      open_events: open.length,
      highest_severity:
        open.reduce<(typeof order)[number] | null>(
          (w, e) => (w === null || order.indexOf(e.severity) > order.indexOf(w) ? e.severity : w),
          null,
        ) ?? null,
      estimated_loss_fraction:
        zones.reduce((s, z) => s + z.loss_fraction, 0) / Math.max(zones.length, 1),
    };
  }

  /* ---- 23.3 control ---- */
  commandSampling = (id: NodeId, body: SamplingCommand) =>
    this.post<CommandAck>(`/nodes/${encodeURIComponent(id)}/commands/sampling`, body);

  commandRawWindow = (id: NodeId, body: RawWindowCommand) =>
    this.post<CommandAck>(`/nodes/${encodeURIComponent(id)}/commands/raw-window`, body);

  commandDiagnostics = (id: NodeId, body: DiagnosticsCommand) =>
    this.post<CommandAck>(`/nodes/${encodeURIComponent(id)}/commands/diagnostics`, body);

  commandConfig = (id: NodeId, body: ConfigCommand) =>
    this.post<CommandAck>(`/nodes/${encodeURIComponent(id)}/commands/config`, body);

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    if (!this.timer) {
      this.timer = setInterval(() => {
        for (const l of this.listeners) l();
      }, this.pollMs);
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }
}
