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
import type { ApiClient } from './client';
import type { PlatformSimulator } from './platformSimulator';

/**
 * The platform API served from the in-browser simulator.
 *
 * Implements exactly the same interface as the HTTP client, so no page can
 * tell them apart — which is what the dossier asks for when it says simulation
 * must use the production ingestion and query contracts (§30.2).
 *
 * Reads resolve immediately: there is no network, and pretending otherwise
 * with an artificial delay would only make the UI feel worse than it is.
 * Commands do take time, because a real command round-trips to a device and
 * the interface has to behave as though it might not come back.
 */

let commandCounter = 0;

export class SimulatedApiClient implements ApiClient {
  readonly mode = 'SIMULATION' as const;
  readonly label = 'Simulated network';

  constructor(private readonly platform: PlatformSimulator) {}

  /* ---- 23.1 ingest ----------------------------------------------------
   * In simulation the nodes are the source, so an inbound frame is a loopback
   * rather than an error: accept and publish it on the device bus so anything
   * mirroring device traffic still sees it.
   */

  async postTelemetry(frame: TelemetryFrame): Promise<void> {
    this.platform.bus.publish(frame.node_id, 'telemetry', frame);
  }

  async postFlowSignature(signature: FlowSignature): Promise<void> {
    this.platform.bus.publish(signature.node_id, 'signature', signature);
  }

  async postHealth(health: NodeHealth): Promise<void> {
    this.platform.bus.publish(health.node_id, 'health', health);
  }

  async postEvent(event: WaterEvent): Promise<void> {
    this.platform.bus.publish(event.node_id, 'event', event);
  }

  /* ---- 23.2 query ---- */

  async getNodes(): Promise<NodeSummary[]> {
    return [...this.platform.nodes.values()].map((sim) => ({
      ...sim.node,
      state: sim.state,
      health: sim.health,
      anomaly_score: sim.anomalyScore,
      flow_lps: sim.outletFlowLps,
      sampling_mode: sim.samplingMode,
      last_seen: sim.lastSeen,
    }));
  }

  async getNode(nodeId: NodeId): Promise<AquaNereonNode> {
    const sim = this.require(nodeId);
    return sim.node;
  }

  async getNodeTelemetry(nodeId: NodeId, query?: TelemetryQuery): Promise<TelemetryFrame[]> {
    const frames = this.require(nodeId).telemetry;
    const limit = query?.limit ?? frames.length;
    return frames.slice(-limit);
  }

  async getNodeSignature(nodeId: NodeId): Promise<FlowSignature> {
    return this.require(nodeId).signature;
  }

  async getNodeSignatureHistory(nodeId: NodeId, limit = 60): Promise<FlowSignature[]> {
    return this.require(nodeId).signatures.slice(-limit);
  }

  async getNodeState(nodeId: NodeId): Promise<NodeState> {
    const sim = this.require(nodeId);
    return {
      node_id: nodeId,
      state: sim.state,
      previous_state: sim.previousState,
      since: new Date(Date.now() - (sim.stateSince > 0 ? 0 : 0)).toISOString(),
      baseline_distance: sim.signature.baseline_distance,
      anomaly_score: sim.anomalyScore,
      sampling_mode: sim.samplingMode,
      health: sim.health,
    };
  }

  async getNodeHealth(nodeId: NodeId): Promise<NodeHealth> {
    return this.require(nodeId).health_report;
  }

  async getZones(): Promise<ZoneSummary[]> {
    return this.platform.zones.map((z) => this.platform.zoneSummary(z.zone_id));
  }

  async getZoneSummary(zoneId: ZoneId): Promise<ZoneSummary> {
    return this.platform.zoneSummary(zoneId);
  }

  async getEvents(query: EventQuery = {}): Promise<Page<WaterEvent>> {
    let items = this.platform.allEvents();
    if (query.node_id) items = items.filter((e) => e.node_id === query.node_id);
    if (query.zone_id) items = items.filter((e) => e.zone_id === query.zone_id);
    if (query.severity) items = items.filter((e) => e.severity === query.severity);
    if (query.status) items = items.filter((e) => e.status === query.status);
    const total = items.length;
    return { items: items.slice(0, query.limit ?? 50), total };
  }

  async getForecasts(query: ForecastQuery = {}): Promise<DemandForecast[]> {
    const scope = query.scope ?? 'CITY';
    if (scope === 'CITY') return [this.platform.forecast('CITY', 'CITY')];
    if (scope === 'ZONE') {
      const ids = query.target_id
        ? [query.target_id]
        : this.platform.zones.map((z) => z.zone_id);
      return ids.map((id) => this.platform.forecast('ZONE', id));
    }
    const ids = query.target_id ? [query.target_id] : [...this.platform.nodes.keys()];
    return ids.map((id) => this.platform.forecast('NODE', id));
  }

  async getRecommendations(): Promise<Recommendation[]> {
    return this.platform.allRecommendations();
  }

  async getNetwork(): Promise<NetworkGraph> {
    return this.platform.network;
  }

  async getCityOverview(): Promise<CityOverview> {
    return this.platform.cityOverview();
  }

  /* ---- 23.3 control ---- */

  private async issueCommand(
    nodeId: NodeId,
    kind: 'sampling' | 'raw-window' | 'diagnostics' | 'config',
    body: object,
    apply?: () => void,
  ): Promise<CommandAck> {
    const sim = this.require(nodeId);
    const command_id = `CMD-${++commandCounter}`;
    const issued_at = new Date().toISOString();

    this.platform.bus.publish(nodeId, 'command', {
      command_id,
      kind,
      body,
    } as never);

    if (sim.health === 'OFFLINE') {
      // An offline node does not acknowledge. The UI has to cope with that,
      // so the simulator must be capable of producing it.
      return {
        command_id,
        node_id: nodeId,
        accepted: false,
        issued_at,
        detail: 'Node did not acknowledge: communication offline.',
      };
    }

    // Round-trip delay: edge processors are not instantaneous, and a control
    // surface that pretends they are teaches the wrong expectations.
    await new Promise((resolve) => setTimeout(resolve, 260 + Math.random() * 240));
    apply?.();

    const ack: CommandAck = {
      command_id,
      node_id: nodeId,
      accepted: true,
      issued_at,
      acknowledged_at: new Date().toISOString(),
    };
    this.platform.bus.publish(nodeId, 'ack', ack);
    return ack;
  }

  commandSampling(nodeId: NodeId, body: SamplingCommand): Promise<CommandAck> {
    return this.issueCommand(nodeId, 'sampling', body, () =>
      this.require(nodeId).applySampling(body.mode, body.duration_sec ?? 180),
    );
  }

  commandRawWindow(nodeId: NodeId, body: RawWindowCommand): Promise<CommandAck> {
    return this.issueCommand(nodeId, 'raw-window', body);
  }

  commandDiagnostics(nodeId: NodeId, body: DiagnosticsCommand): Promise<CommandAck> {
    return this.issueCommand(nodeId, 'diagnostics', body);
  }

  commandConfig(nodeId: NodeId, body: ConfigCommand): Promise<CommandAck> {
    return this.issueCommand(nodeId, 'config', body);
  }

  subscribe(listener: () => void): () => void {
    return this.platform.subscribe(listener);
  }

  private require(nodeId: NodeId) {
    const sim = this.platform.nodes.get(nodeId);
    if (!sim) throw new Error(`Unknown node ${nodeId}`);
    return sim;
  }
}
