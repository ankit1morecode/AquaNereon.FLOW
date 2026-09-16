/**
 * Wire types for the AquaNereon.FLOW platform API.
 *
 * These mirror the endpoint and payload contracts in the software dossier
 * (§23 REST, §24 MQTT) rather than being invented for the UI's convenience.
 * Everything the frontend renders comes through here, so when the real backend
 * arrives the change is a base URL, not a data model.
 *
 * Naming note: the wire uses snake_case, because that is what a Python/FastAPI
 * backend emits. The boundary is not the place to start renaming things.
 */

/* ================================================================== */
/* Identity                                                            */
/* ================================================================== */

export type NodeId = string;
export type ZoneId = string;
export type EventId = string;

export type FlowState = 'STABLE' | 'DRIFT' | 'PRE_DISTURBANCE' | 'DISTURBANCE';
export type HealthStatus = 'OK' | 'DEGRADED' | 'FAULT' | 'OFFLINE';
export type Severity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type SamplingMode = 'NORMAL' | 'INCREASED' | 'HIGH_RESOLUTION' | 'VERIFICATION';

/** Dossier §2: a single sensor value is never the whole state. */
export interface DataQuality {
  /** 0..1 */
  completeness: number;
  /** 0..1 */
  confidence: number;
  stale: boolean;
  /** Channels the edge flagged as untrustworthy this window. */
  suspect_channels: number[];
}

/* ================================================================== */
/* Nodes (GET /api/v1/nodes, /nodes/{id})                              */
/* ================================================================== */

export interface NodeLocation {
  /** Schematic layout coordinates for the network view, 0..1 in both axes. */
  x: number;
  y: number;
  label: string;
}

export interface AquaNereonNode {
  node_id: NodeId;
  zone_id: ZoneId;
  hardware_version: string;
  firmware_version: string;
  location: NodeLocation;
  /** Nominal design throughput of the junction, L/s. */
  nominal_flow_lps: number;
  /** Node ids immediately upstream and downstream in the hydraulic graph. */
  upstream: NodeId[];
  downstream: NodeId[];
  commissioned_at: string;
}

export interface NodeSummary extends AquaNereonNode {
  state: FlowState;
  health: HealthStatus;
  anomaly_score: number;
  flow_lps: number;
  sampling_mode: SamplingMode;
  last_seen: string;
}

/* ================================================================== */
/* Telemetry (POST /telemetry, GET /nodes/{id}/telemetry)              */
/* ================================================================== */

export interface TelemetryFrame {
  node_id: NodeId;
  timestamp: string;
  flow: { a: number; b: number; out: number };
  pressure: { a: number; b: number; out: number };
  acoustic_rms: number;
  conductivity_us_cm: number;
  turbidity_ntu: number;
  temperature_c: number;
  /** Raw circumferential channel readings, one per ring element. */
  circumferential_channels: number[];
  data_quality: DataQuality;
}

/* ================================================================== */
/* Flow signatures (POST /flow-signatures, GET /nodes/{id}/signature)   */
/* ================================================================== */

/** Dossier §8: the circumferential group is never reduced to one scalar. */
export interface CircumferentialFeatures {
  channel_features: number[];
  /** Channels normalised to unit mean — the comparable distribution vector. */
  distribution_vector: number[];
  asymmetry: number;
  sector_imbalance: number;
  spatial_gradient: number;
  /** First three circumferential Fourier modes. */
  modes: [number, number, number];
  mode1_phase: number;
}

export interface HydraulicFeatures {
  flow_mean: number;
  flow_variation: number;
  pressure_mean: number;
  pressure_variation: number;
  swirl_number: number;
  axial_deficit: number;
}

export interface TemporalFeatures {
  rate_of_change: number;
  persistence: number;
  drift: number;
  sudden_deviation: number;
}

export interface FlowSignature {
  signature_id: string;
  node_id: NodeId;
  timestamp: string;
  window_start: string;
  window_end: string;
  hydraulic: HydraulicFeatures;
  acoustic: { rms: number; peak: number; dominant_hz: number; spectral_energy: number };
  circumferential: CircumferentialFeatures;
  water_properties: { conductivity: number; turbidity: number; temperature: number };
  temporal: TemporalFeatures;
  baseline_id: string;
  baseline_distance: number;
  confidence: number;
  data_quality: DataQuality;
  state: FlowState;
}

/** GET /nodes/{id}/state */
export interface NodeState {
  node_id: NodeId;
  state: FlowState;
  previous_state: FlowState;
  since: string;
  baseline_distance: number;
  anomaly_score: number;
  sampling_mode: SamplingMode;
  health: HealthStatus;
}

/* ================================================================== */
/* Health (POST /health)                                               */
/* ================================================================== */

export interface NodeHealth {
  node_id: NodeId;
  timestamp: string;
  sensor_status: HealthStatus;
  power_status: HealthStatus;
  communication_status: HealthStatus;
  calibration_status: HealthStatus;
  /** Seconds since the last accepted telemetry frame. */
  telemetry_age_sec: number;
  packet_loss: number;
  battery_pct?: number;
  rssi_dbm?: number;
}

/* ================================================================== */
/* Events (POST /events, GET /events)                                  */
/* ================================================================== */

export type EventType =
  | 'FLOW_ANOMALY'
  | 'LEAKAGE_SUSPECTED'
  | 'PRESSURE_DISTURBANCE'
  | 'CONSUMPTION_SPIKE'
  | 'SHORTAGE_RISK'
  | 'SENSOR_FAULT'
  | 'NETWORK_EVENT';

/** Dossier §16: an event carries the evidence it was formed from. */
export interface EvidenceItem {
  kind:
    | 'SENSOR'
    | 'SIGNATURE_DEVIATION'
    | 'BASELINE'
    | 'RATE_OF_CHANGE'
    | 'PERSISTENCE'
    | 'NEIGHBOUR'
    | 'MODEL'
    | 'DATA_QUALITY';
  label: string;
  value: string;
  /** How much this item contributed to the conclusion, 0..1. */
  weight: number;
  detail?: string;
}

export interface ModelOutput {
  model_id: string;
  model_version: string;
  prediction: string;
  score: number;
  confidence: number;
  contributing_features: string[];
  explanation: string[];
}

export interface WaterEvent {
  event_id: EventId;
  event_type: EventType;
  node_id: NodeId;
  zone_id: ZoneId;
  timestamp: string;
  severity: Severity;
  anomaly_score: number;
  state_transition: { from: FlowState; to: FlowState };
  evidence: EvidenceItem[];
  model_outputs: ModelOutput[];
  network_context: {
    upstream_states: { node_id: NodeId; state: FlowState }[];
    downstream_states: { node_id: NodeId; state: FlowState }[];
    propagation: 'LOCAL' | 'PROPAGATED' | 'NETWORK_WIDE';
  };
  data_quality: DataQuality;
  suspected_origin?: { description: string; confidence: number };
  recommended_action?: { action: string; priority: number; rationale: string };
  status: 'OPEN' | 'ACKNOWLEDGED' | 'INTERVENING' | 'VERIFYING' | 'CLOSED';
  intervention_id?: string;
  verification_id?: string;
}

/* ================================================================== */
/* Zones (GET /zones/{id}/summary)                                     */
/* ================================================================== */

export interface Zone {
  zone_id: ZoneId;
  name: string;
  population: number;
  node_ids: NodeId[];
}

export interface ZoneSummary extends Zone {
  supply_lps: number;
  demand_lps: number;
  /** Supply minus metered consumption, as a fraction of supply. */
  loss_fraction: number;
  open_events: number;
  worst_state: FlowState;
  shortage_risk: number;
  forecast_peak_lps: number;
  /** Recent consumption, one sample per hour. */
  consumption_series: TimePoint[];
}

/* ================================================================== */
/* Forecasts (GET /forecasts)                                          */
/* ================================================================== */

export interface TimePoint {
  t: string;
  v: number;
}

export interface ForecastPoint extends TimePoint {
  /** Prediction interval, where the model supports one. */
  lo?: number;
  hi?: number;
}

export interface DemandForecast {
  forecast_id: string;
  scope: 'NODE' | 'ZONE' | 'CITY';
  target_id: string;
  model_id: string;
  issued_at: string;
  horizon_hours: number;
  history: TimePoint[];
  forecast: ForecastPoint[];
  /** Mean absolute percentage error over the last completed horizon. */
  backtest_mape: number;
}

/* ================================================================== */
/* Recommendations (GET /recommendations)                              */
/* ================================================================== */

export interface Recommendation {
  recommendation_id: string;
  event_id?: EventId;
  zone_id?: ZoneId;
  node_id?: NodeId;
  issued_at: string;
  priority: number;
  action: string;
  rationale: string;
  expected_effect: string;
  verification: string;
  status: 'PROPOSED' | 'ACCEPTED' | 'REJECTED' | 'DONE';
}

/* ================================================================== */
/* Network graph (GET /network)                                        */
/* ================================================================== */

export type NetworkNodeKind = 'JUNCTION' | 'RESERVOIR' | 'PUMP' | 'VALVE' | 'DEMAND';

export interface NetworkVertex {
  id: string;
  kind: NetworkNodeKind;
  zone_id: ZoneId;
  location: NodeLocation;
}

export interface NetworkEdge {
  pipe_id: string;
  from: string;
  to: string;
  diameter_mm: number;
  length_m: number;
  nominal_flow_lps: number;
  nominal_pressure_kpa: number;
}

export interface NetworkGraph {
  vertices: NetworkVertex[];
  edges: NetworkEdge[];
  zones: Zone[];
}

/* ================================================================== */
/* City roll-up                                                        */
/* ================================================================== */

export interface CityOverview {
  timestamp: string;
  supply_lps: number;
  demand_lps: number;
  reservoir_fraction: number;
  nodes_total: number;
  nodes_by_state: Record<FlowState, number>;
  open_events: number;
  highest_severity: Severity | null;
  estimated_loss_fraction: number;
}

/* ================================================================== */
/* Control (§23.3)                                                     */
/* ================================================================== */

export interface SamplingCommand {
  mode: SamplingMode;
  /** Requested sample rate in Hz; the edge may clamp it. */
  rate_hz?: number;
  duration_sec?: number;
}

export interface RawWindowCommand {
  window_sec: number;
  channels?: number[];
}

export interface DiagnosticsCommand {
  suite: 'QUICK' | 'FULL' | 'CALIBRATION';
}

export interface ConfigCommand {
  [key: string]: string | number | boolean;
}

export interface CommandAck {
  command_id: string;
  node_id: NodeId;
  accepted: boolean;
  issued_at: string;
  acknowledged_at?: string;
  detail?: string;
}

/* ================================================================== */
/* Collection envelopes                                                */
/* ================================================================== */

export interface Page<T> {
  items: T[];
  total: number;
}

export interface EventQuery {
  node_id?: NodeId;
  zone_id?: ZoneId;
  severity?: Severity;
  status?: WaterEvent['status'];
  since?: string;
  limit?: number;
}

export interface ForecastQuery {
  scope?: DemandForecast['scope'];
  target_id?: string;
  horizon_hours?: number;
}

export interface TelemetryQuery {
  since?: string;
  limit?: number;
}
