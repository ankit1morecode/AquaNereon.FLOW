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

/**
 * The platform API, exactly as the software dossier specifies it (§23).
 *
 * One interface, two implementations: `HttpApiClient` talks to the real
 * backend, `SimulatedApiClient` runs the whole platform in the browser. The
 * dossier requires that simulation and hardware share ingestion and query
 * contracts (§16, §30.2), and this is where that requirement is enforced —
 * no page can tell which one it is talking to.
 */
export interface ApiClient {
  readonly mode: 'REAL' | 'SIMULATION';
  readonly label: string;

  /* ---- 23.1 device telemetry (ingest) ---- */
  postTelemetry(frame: TelemetryFrame): Promise<void>;
  postFlowSignature(signature: FlowSignature): Promise<void>;
  postHealth(health: NodeHealth): Promise<void>;
  postEvent(event: WaterEvent): Promise<void>;

  /* ---- 23.2 query ---- */
  getNodes(): Promise<NodeSummary[]>;
  getNode(nodeId: NodeId): Promise<AquaNereonNode>;
  getNodeTelemetry(nodeId: NodeId, query?: TelemetryQuery): Promise<TelemetryFrame[]>;
  getNodeSignature(nodeId: NodeId): Promise<FlowSignature>;
  getNodeSignatureHistory(nodeId: NodeId, limit?: number): Promise<FlowSignature[]>;
  getNodeState(nodeId: NodeId): Promise<NodeState>;
  getNodeHealth(nodeId: NodeId): Promise<NodeHealth>;
  getZoneSummary(zoneId: ZoneId): Promise<ZoneSummary>;
  getZones(): Promise<ZoneSummary[]>;
  getEvents(query?: EventQuery): Promise<Page<WaterEvent>>;
  getForecasts(query?: ForecastQuery): Promise<DemandForecast[]>;
  getRecommendations(): Promise<Recommendation[]>;
  getNetwork(): Promise<NetworkGraph>;
  getCityOverview(): Promise<CityOverview>;

  /* ---- 23.3 control ---- */
  commandSampling(nodeId: NodeId, body: SamplingCommand): Promise<CommandAck>;
  commandRawWindow(nodeId: NodeId, body: RawWindowCommand): Promise<CommandAck>;
  commandDiagnostics(nodeId: NodeId, body: DiagnosticsCommand): Promise<CommandAck>;
  commandConfig(nodeId: NodeId, body: ConfigCommand): Promise<CommandAck>;

  /**
   * Subscribe to platform changes. The HTTP client polls; the simulator emits
   * on its own tick. Returns an unsubscribe function.
   */
  subscribe(listener: () => void): () => void;
}

/** Thrown for any non-2xx response, so pages can show the status rather than a blank. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly endpoint: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
