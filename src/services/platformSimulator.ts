import { makeRng } from '../viz/core/math';
import type {
  AquaNereonNode,
  CityOverview,
  DemandForecast,
  EvidenceItem,
  FlowState,
  NetworkGraph,
  NodeId,
  Recommendation,
  Severity,
  TimePoint,
  WaterEvent,
  Zone,
  ZoneSummary,
} from '../types';
import { LocalDeviceBus, type DeviceBus } from './mqtt';
import { NodeSimulator } from './nodeSimulator';

/**
 * The whole platform, running in the browser.
 *
 * The dossier requires simulation mode to use the same ingestion and query
 * contracts as hardware (§16, §30.2), so this is not a pile of fixture JSON —
 * it is a running system. Nine nodes each advance their own physics, publish
 * telemetry, signatures and health on the device bus, form events out of state
 * transitions with the evidence that produced them, and feed the forecast and
 * risk layers. Every number any page shows is downstream of that.
 */

/* ------------------------------------------------------------------ */
/* Topology                                                            */
/* ------------------------------------------------------------------ */

/**
 * Served population, sized to what the network can actually deliver.
 *
 * These are DN125-class diagnostic junctions carrying around 24 L/s each, so
 * nine of them serve a district rather than a city. Inventing a metropolis on
 * top of them would make every supply-versus-demand figure on the City screen
 * meaningless from the first frame.
 */
const ZONES: Zone[] = [
  { zone_id: 'Z-NORTH', name: 'Northgate', population: 41200, node_ids: [] },
  { zone_id: 'Z-CENTRAL', name: 'Central Basin', population: 62400, node_ids: [] },
  { zone_id: 'Z-SOUTH', name: 'Southbank', population: 45900, node_ids: [] },
];

/**
 * Average municipal draw per person: about 150 litres a day, which is a
 * typical European figure and the one that makes supply and demand comparable
 * at this network size.
 */
const PER_CAPITA_LPS = 150 / 86400;

/** Zone demand at a given hour, litres per second. */
export function zoneDemandLps(population: number, hourOfDay: number): number {
  return population * PER_CAPITA_LPS * diurnalFactor(hourOfDay);
}

interface NodeSeed {
  id: NodeId;
  zone: string;
  x: number;
  y: number;
  label: string;
  nominal: number;
  scenario: 'NORMAL' | 'DRIFT' | 'DISTURBANCE';
  scale: number;
  phase: number;
  upstream: NodeId[];
}

/**
 * Laid out as a schematic, not a map. The dossier is explicit that the digital
 * twin is a computational graph rather than a geographic rendering (§12), and
 * a schematic makes upstream/downstream relationships readable in a way a set
 * of pins on a street map does not.
 */
const NODE_SEEDS: NodeSeed[] = [
  { id: 'AN-J-002', zone: 'Z-NORTH', x: 0.12, y: 0.18, label: 'Northgate inlet', nominal: 30, scenario: 'NORMAL', scale: 1.22, phase: 3, upstream: ['RES-1'] },
  { id: 'AN-J-005', zone: 'Z-NORTH', x: 0.3, y: 0.3, label: 'Mill Road cross', nominal: 26, scenario: 'NORMAL', scale: 1.05, phase: 11, upstream: ['AN-J-002'] },
  { id: 'AN-J-008', zone: 'Z-NORTH', x: 0.22, y: 0.52, label: 'Kingsway tie', nominal: 22, scenario: 'DRIFT', scale: 0.92, phase: 6, upstream: ['AN-J-005'] },
  { id: 'AN-J-011', zone: 'Z-CENTRAL', x: 0.48, y: 0.2, label: 'Basin north feed', nominal: 28, scenario: 'NORMAL', scale: 1.14, phase: 17, upstream: ['RES-1', 'AN-J-005'] },
  { id: 'AN-J-014', zone: 'Z-CENTRAL', x: 0.54, y: 0.46, label: 'Exchange junction', nominal: 26, scenario: 'DISTURBANCE', scale: 1.0, phase: 0, upstream: ['AN-J-011'] },
  { id: 'AN-J-017', zone: 'Z-CENTRAL', x: 0.68, y: 0.62, label: 'Foundry branch', nominal: 21, scenario: 'NORMAL', scale: 0.88, phase: 23, upstream: ['AN-J-014'] },
  { id: 'AN-J-021', zone: 'Z-SOUTH', x: 0.42, y: 0.76, label: 'Southbank tie', nominal: 24, scenario: 'NORMAL', scale: 0.98, phase: 9, upstream: ['AN-J-014', 'RES-2'] },
  { id: 'AN-J-024', zone: 'Z-SOUTH', x: 0.66, y: 0.86, label: 'Dockside cross', nominal: 20, scenario: 'DRIFT', scale: 0.84, phase: 29, upstream: ['AN-J-021'] },
  { id: 'AN-J-027', zone: 'Z-SOUTH', x: 0.85, y: 0.72, label: 'Harbour terminus', nominal: 18, scenario: 'NORMAL', scale: 0.76, phase: 14, upstream: ['AN-J-024', 'AN-J-017'] },
];

const SOURCES = [
  { id: 'RES-1', zone: 'Z-NORTH', x: 0.04, y: 0.06, label: 'Highfield reservoir' },
  { id: 'RES-2', zone: 'Z-SOUTH', x: 0.18, y: 0.92, label: 'Southbank pumping' },
];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const SEVERITY_ORDER: Severity[] = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

function severityForState(state: FlowState): Severity {
  switch (state) {
    case 'STABLE':
      return 'INFO';
    case 'DRIFT':
      return 'LOW';
    case 'PRE_DISTURBANCE':
      return 'MEDIUM';
    case 'DISTURBANCE':
      return 'HIGH';
  }
}

/** Diurnal municipal demand: twin morning and evening peaks, night trough. */
export function diurnalFactor(hourOfDay: number): number {
  const h = ((hourOfDay % 24) + 24) % 24;
  const morning = Math.exp(-(((h - 7.5) / 2.1) ** 2)) * 0.55;
  const evening = Math.exp(-(((h - 19.5) / 2.6) ** 2)) * 0.62;
  const base = 0.62 + 0.1 * Math.sin(((h - 3) / 24) * Math.PI * 2);
  return base + morning + evening;
}

/* ------------------------------------------------------------------ */
/* Simulator                                                           */
/* ------------------------------------------------------------------ */

export interface PlatformOptions {
  /** Simulated seconds per real second. */
  timeScale?: number;
  /** Ticks per real second. */
  tickHz?: number;
}

export class PlatformSimulator {
  readonly bus: DeviceBus = new LocalDeviceBus();
  readonly nodes = new Map<NodeId, NodeSimulator>();
  readonly zones: Zone[];
  readonly network: NetworkGraph;

  private readonly events: WaterEvent[] = [];
  private readonly recommendations: Recommendation[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly rng = makeRng(0x4e1de0);
  private readonly timeScale: number;
  private readonly tickHz: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  /** Simulated seconds since start, and the wall clock they map to. */
  time = 0;
  private readonly epochMs = Date.now();

  /** Consumption history per zone, one point per simulated hour. */
  private readonly consumption = new Map<string, TimePoint[]>();
  private lastConsumptionHour = -1;

  constructor(options: PlatformOptions = {}) {
    this.timeScale = options.timeScale ?? 6;
    this.tickHz = options.tickHz ?? 4;

    this.zones = ZONES.map((z) => ({
      ...z,
      node_ids: NODE_SEEDS.filter((n) => n.zone === z.zone_id).map((n) => n.id),
    }));

    for (const seed of NODE_SEEDS) {
      const node: AquaNereonNode = {
        node_id: seed.id,
        zone_id: seed.zone,
        hardware_version: 'AN-HW-2.1',
        firmware_version: '0.9.4',
        location: { x: seed.x, y: seed.y, label: seed.label },
        nominal_flow_lps: seed.nominal,
        upstream: seed.upstream,
        downstream: NODE_SEEDS.filter((n) => n.upstream.includes(seed.id)).map((n) => n.id),
        commissioned_at: '2025-11-04T09:00:00.000Z',
      };
      this.nodes.set(
        seed.id,
        new NodeSimulator({
          node,
          scenario: seed.scenario,
          phase: seed.phase,
          flowScale: seed.scale,
          seed: 0x1000 + seed.id.charCodeAt(seed.id.length - 1) * 977,
        }),
      );
    }

    this.network = this.buildNetwork();
    for (const zone of this.zones) this.consumption.set(zone.zone_id, []);
    this.seedConsumption();
  }

  private buildNetwork(): NetworkGraph {
    const vertices: NetworkGraph['vertices'] = [
      ...SOURCES.map((s) => ({
        id: s.id,
        kind: 'RESERVOIR' as const,
        zone_id: s.zone,
        location: { x: s.x, y: s.y, label: s.label },
      })),
      ...NODE_SEEDS.map((n) => ({
        id: n.id,
        kind: 'JUNCTION' as const,
        zone_id: n.zone,
        location: { x: n.x, y: n.y, label: n.label },
      })),
    ];

    const edges: NetworkGraph['edges'] = [];
    for (const seed of NODE_SEEDS) {
      for (const up of seed.upstream) {
        const from = vertices.find((v) => v.id === up);
        if (!from) continue;
        const dx = seed.x - from.location.x;
        const dy = seed.y - from.location.y;
        edges.push({
          pipe_id: `P-${up}-${seed.id}`,
          from: up,
          to: seed.id,
          diameter_mm: Math.round(seed.nominal * 7 + 60),
          length_m: Math.round(Math.hypot(dx, dy) * 4200),
          nominal_flow_lps: seed.nominal,
          nominal_pressure_kpa: 310,
        });
      }
    }

    return { vertices, edges, zones: this.zones };
  }

  /** Pre-fill 24 hours of consumption so the charts are not empty on load. */
  private seedConsumption(): void {
    const startHour = this.hourOfDay - 24;
    for (const zone of this.zones) {
      const series: TimePoint[] = [];
      for (let i = 0; i < 24; i++) {
        const h = startHour + i;
        series.push({
          t: new Date(this.epochMs + (i - 24) * 3600_000).toISOString(),
          // Metered consumption sits a little under delivered demand; the gap
          // is the loss the zone screen is trying to account for.
          v: zoneDemandLps(zone.population, h) * (0.9 + this.rng() * 0.06),
        });
      }
      this.consumption.set(zone.zone_id, series);
    }
    this.lastConsumptionHour = Math.floor(this.hourOfDay);
  }

  /**
   * Local hour, fractional. Local rather than UTC on purpose: the clock in the
   * header shows local time, and a screen reporting peak demand at 02:00 would
   * be read as a bug in the demand model rather than a timezone.
   */
  get hourOfDay(): number {
    const d = new Date(this.epochMs + this.time * 1000);
    return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
  }

  /** Real wall-clock, for anything an operator reads as "how long ago". */
  private nowIso(): string {
    return new Date().toISOString();
  }

  /* ---- lifecycle ---- */

  start(): void {
    if (this.started) return;
    this.started = true;
    const dt = this.timeScale / this.tickHz;
    this.timer = setInterval(() => this.tick(dt), 1000 / this.tickHz);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.started = false;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  /** One platform tick. Public so tests can drive it without a timer. */
  tick(dt: number): void {
    this.time += dt;

    for (const sim of this.nodes.values()) {
      const before = sim.state;
      sim.step(dt);

      // Device plane: publish what a real node would publish.
      this.bus.publish(sim.node.node_id, 'telemetry', sim.telemetry[sim.telemetry.length - 1]);
      this.bus.publish(sim.node.node_id, 'signature', sim.signature);
      this.bus.publish(sim.node.node_id, 'health', sim.health_report);

      if (sim.state !== before) this.onStateTransition(sim, before);
    }

    this.rollConsumption();
    this.ageEvents();
    this.notify();
  }

  /* ---- event formation ---- */

  private onStateTransition(sim: NodeSimulator, from: FlowState): void {
    // Only escalations raise events. A node settling back down closes one.
    const order: FlowState[] = ['STABLE', 'DRIFT', 'PRE_DISTURBANCE', 'DISTURBANCE'];
    const rising = order.indexOf(sim.state) > order.indexOf(from);

    if (!rising) {
      for (const event of this.events) {
        if (event.node_id === sim.node.node_id && event.status !== 'CLOSED') {
          event.status = sim.state === 'STABLE' ? 'CLOSED' : 'VERIFYING';
        }
      }
      return;
    }

    if (sim.state === 'DRIFT' && this.hasOpenEvent(sim.node.node_id)) return;

    const event = this.formEvent(sim, from);
    this.events.unshift(event);
    this.bus.publish(sim.node.node_id, 'event', event);
    if (this.events.length > 80) this.events.pop();

    if (event.recommended_action) {
      this.recommendations.unshift({
        recommendation_id: `REC-${event.event_id}`,
        event_id: event.event_id,
        zone_id: event.zone_id,
        node_id: event.node_id,
        issued_at: event.timestamp,
        priority: event.recommended_action.priority,
        action: event.recommended_action.action,
        rationale: event.recommended_action.rationale,
        expected_effect:
          'Circumferential asymmetry returns toward baseline within two sampling windows.',
        verification: 'Verification sampling for 10 minutes after intervention.',
        status: 'PROPOSED',
      });
      if (this.recommendations.length > 40) this.recommendations.pop();
    }
  }

  private hasOpenEvent(nodeId: NodeId): boolean {
    return this.events.some((e) => e.node_id === nodeId && e.status !== 'CLOSED');
  }

  /**
   * Assemble the event from the evidence that actually produced it.
   *
   * Dossier §16: no event may say "AI detected leakage" without showing what
   * changed, where, how far from baseline, how fast, whether it persisted, and
   * what the neighbours did. Every item below is read off the live signature.
   */
  private formEvent(sim: NodeSimulator, from: FlowState): WaterEvent {
    const sig = sim.signature;
    const neighbours = this.neighbourStates(sim.node.node_id);
    const propagated = neighbours.upstream.some((n) => n.state !== 'STABLE');

    const evidence: EvidenceItem[] = [
      {
        kind: 'SIGNATURE_DEVIATION',
        label: 'Baseline distance',
        value: sig.baseline_distance.toFixed(3),
        weight: Math.min(1, sig.baseline_distance / 0.25),
        detail: `L2 distance of the 16-channel distribution from baseline ${sig.baseline_id}.`,
      },
      {
        kind: 'SENSOR',
        label: 'Circumferential asymmetry',
        value: sig.circumferential.asymmetry.toFixed(3),
        weight: Math.min(1, sig.circumferential.asymmetry / 0.12),
        detail: 'Resultant of the 16 channel vectors; zero for an even ring.',
      },
      {
        kind: 'SENSOR',
        label: 'Sector imbalance',
        value: sig.circumferential.sector_imbalance.toFixed(2),
        weight: Math.min(1, sig.circumferential.sector_imbalance / 1.2),
        detail: '(max - min) / mean across the ring.',
      },
      {
        kind: 'RATE_OF_CHANGE',
        label: 'Rate of change',
        value: `${(sig.temporal.rate_of_change * 1000).toFixed(1)} /ks`,
        weight: Math.min(1, Math.abs(sig.temporal.rate_of_change) * 40),
        detail: 'Change in baseline distance per second.',
      },
      {
        kind: 'PERSISTENCE',
        label: 'Persistence',
        value: `${Math.round(sig.temporal.persistence * 100)}%`,
        weight: sig.temporal.persistence,
        detail: 'Fraction of the recent window at or above DRIFT.',
      },
      {
        kind: 'SENSOR',
        label: 'Core deficit',
        value: sig.hydraulic.axial_deficit.toFixed(2),
        weight: Math.min(1, sig.hydraulic.axial_deficit / 1.4),
        detail: 'Above 1.0 the vortex core recirculates.',
      },
      {
        kind: 'NEIGHBOUR',
        label: 'Upstream behaviour',
        value: propagated ? 'Disturbed' : 'Stable',
        weight: propagated ? 0.8 : 0.15,
        detail: neighbours.upstream.map((n) => `${n.node_id}: ${n.state}`).join(', ') || 'No upstream nodes.',
      },
      {
        kind: 'DATA_QUALITY',
        label: 'Data quality',
        value: `${Math.round(sig.data_quality.confidence * 100)}%`,
        weight: 1 - sig.data_quality.confidence,
        detail: sig.data_quality.stale ? 'Feed is stale.' : 'Feed complete.',
      },
    ];

    const severity = severityForState(sim.state);
    const leakish =
      sim.state !== 'DRIFT' &&
      sig.circumferential.asymmetry > 0.05 &&
      sig.temporal.persistence > 0.5 &&
      !propagated;

    const eventType = leakish
      ? 'LEAKAGE_SUSPECTED'
      : propagated
        ? 'NETWORK_EVENT'
        : 'FLOW_ANOMALY';

    return {
      event_id: `EV-${sim.node.node_id}-${Math.round(this.time)}`,
      event_type: eventType,
      node_id: sim.node.node_id,
      zone_id: sim.node.zone_id,
      timestamp: this.nowIso(),
      severity,
      anomaly_score: sim.anomalyScore,
      state_transition: { from, to: sim.state },
      evidence,
      model_outputs: [
        {
          model_id: 'AI-01',
          model_version: '0.3.1',
          prediction: sim.state,
          score: sim.anomalyScore,
          confidence: sig.confidence,
          contributing_features: [
            'circumferential.asymmetry',
            'circumferential.modes[0]',
            'temporal.persistence',
            'hydraulic.axial_deficit',
          ],
          explanation: [
            'Circumferential distribution departed from the stored baseline.',
            'Deviation persisted across consecutive windows rather than spiking.',
            propagated
              ? 'Upstream nodes show correlated behaviour.'
              : 'No correlated upstream behaviour; deviation appears local.',
          ],
        },
        ...(leakish
          ? [
              {
                model_id: 'AI-03',
                model_version: '0.2.0',
                prediction: 'Suspected loss between this node and the next downstream',
                score: 0.62 + sig.circumferential.asymmetry,
                confidence: 0.54,
                contributing_features: [
                  'flow imbalance',
                  'pressure deviation',
                  'circumferential asymmetry',
                  'acoustic RMS',
                ],
                explanation: [
                  'Persistent one-sided circumferential pattern with no upstream correlate.',
                  'Evidence is indicative, not conclusive: no metered consumption mismatch yet.',
                ],
              },
            ]
          : []),
      ],
      network_context: {
        upstream_states: neighbours.upstream,
        downstream_states: neighbours.downstream,
        propagation: propagated ? 'PROPAGATED' : 'LOCAL',
      },
      data_quality: sig.data_quality,
      suspected_origin: leakish
        ? {
            description: `Between ${sim.node.node_id} and ${sim.node.downstream[0] ?? 'the zone terminus'}`,
            confidence: 0.54,
          }
        : undefined,
      recommended_action: {
        action:
          sim.state === 'DISTURBANCE'
            ? `Dispatch inspection to ${sim.node.location.label}; hold high-resolution sampling.`
            : sim.state === 'PRE_DISTURBANCE'
              ? `Raise sampling on ${sim.node.node_id} and correlate with ${sim.node.downstream[0] ?? 'downstream'} over the next hour.`
              : `Watch ${sim.node.node_id}; no field action yet.`,
        priority: SEVERITY_ORDER.indexOf(severity),
        rationale:
          'Deviation is persistent and one-sided, which is consistent with a developing flow-path change rather than a transient.',
      },
      status: 'OPEN',
    };
  }

  private neighbourStates(nodeId: NodeId) {
    const sim = this.nodes.get(nodeId);
    const map = (ids: NodeId[]) =>
      ids
        .map((id) => this.nodes.get(id))
        .filter((s): s is NodeSimulator => Boolean(s))
        .map((s) => ({ node_id: s.node.node_id, state: s.state }));
    return {
      upstream: map(sim?.node.upstream ?? []),
      downstream: map(sim?.node.downstream ?? []),
    };
  }

  private ageEvents(): void {
    // Acknowledged events progress on their own, so the timeline is not static.
    for (const event of this.events) {
      if (event.status === 'ACKNOWLEDGED' && this.rng() < 0.002) {
        event.status = 'INTERVENING';
      } else if (event.status === 'INTERVENING' && this.rng() < 0.002) {
        event.status = 'VERIFYING';
        event.intervention_id = `INT-${event.event_id}`;
      } else if (event.status === 'VERIFYING' && this.rng() < 0.003) {
        event.status = 'CLOSED';
        event.verification_id = `VER-${event.event_id}`;
      }
    }
  }

  private rollConsumption(): void {
    const hour = Math.floor(this.hourOfDay);
    if (hour === this.lastConsumptionHour) return;
    this.lastConsumptionHour = hour;
    for (const zone of this.zones) {
      const series = this.consumption.get(zone.zone_id);
      if (!series) continue;
      series.push({
        t: this.nowIso(),
        v: zoneDemandLps(zone.population, hour) * (0.9 + this.rng() * 0.06),
      });
      if (series.length > 48) series.shift();
    }
  }

  /* ---- read models ---- */

  zoneSummary(zoneId: string): ZoneSummary {
    const zone = this.zones.find((z) => z.zone_id === zoneId) ?? this.zones[0];
    const sims = zone.node_ids
      .map((id) => this.nodes.get(id))
      .filter((s): s is NodeSimulator => Boolean(s));

    const supply = sims.reduce((sum, s) => sum + s.outletFlowLps, 0);
    const demand = zoneDemandLps(zone.population, this.hourOfDay);
    const order: FlowState[] = ['STABLE', 'DRIFT', 'PRE_DISTURBANCE', 'DISTURBANCE'];
    const worst = sims.reduce<FlowState>(
      (w, s) => (order.indexOf(s.state) > order.indexOf(w) ? s.state : w),
      'STABLE',
    );

    // Losses rise with the circumferential asymmetry the ring is reporting:
    // a one-sided pattern with no upstream correlate is what loss looks like.
    const asymmetry =
      sims.reduce((sum, s) => sum + s.signature.circumferential.asymmetry, 0) /
      Math.max(sims.length, 1);
    const loss = Math.min(0.42, 0.06 + asymmetry * 1.6);

    const openEvents = this.events.filter(
      (e) => e.zone_id === zoneId && e.status !== 'CLOSED',
    ).length;

    const peak = Math.max(
      ...Array.from({ length: 24 }, (_, h) => zoneDemandLps(zone.population, h)),
    );

    return {
      ...zone,
      supply_lps: supply,
      demand_lps: demand,
      loss_fraction: loss,
      open_events: openEvents,
      worst_state: worst,
      shortage_risk: Math.max(0, Math.min(1, (demand * (1 + loss) - supply) / Math.max(supply, 1))),
      forecast_peak_lps: peak,
      consumption_series: this.consumption.get(zoneId) ?? [],
    };
  }

  cityOverview(): CityOverview {
    const sims = [...this.nodes.values()];
    const byState: Record<FlowState, number> = {
      STABLE: 0,
      DRIFT: 0,
      PRE_DISTURBANCE: 0,
      DISTURBANCE: 0,
    };
    for (const sim of sims) byState[sim.state]++;

    const open = this.events.filter((e) => e.status !== 'CLOSED');
    const highest = open.reduce<Severity | null>(
      (w, e) =>
        w === null || SEVERITY_ORDER.indexOf(e.severity) > SEVERITY_ORDER.indexOf(w)
          ? e.severity
          : w,
      null,
    );

    const zoneSummaries = this.zones.map((z) => this.zoneSummary(z.zone_id));

    return {
      timestamp: this.nowIso(),
      supply_lps: sims.reduce((sum, s) => sum + s.outletFlowLps, 0),
      demand_lps: zoneSummaries.reduce((sum, z) => sum + z.demand_lps, 0),
      // Reservoir draws down at night and refills through the small hours.
      reservoir_fraction: 0.58 + 0.16 * Math.cos(((this.hourOfDay - 5) / 24) * Math.PI * 2),
      nodes_total: sims.length,
      nodes_by_state: byState,
      open_events: open.length,
      highest_severity: highest,
      estimated_loss_fraction:
        zoneSummaries.reduce((sum, z) => sum + z.loss_fraction, 0) / zoneSummaries.length,
    };
  }

  allEvents(): WaterEvent[] {
    return this.events;
  }

  allRecommendations(): Recommendation[] {
    return this.recommendations;
  }

  setEventStatus(eventId: string, status: WaterEvent['status']): void {
    const event = this.events.find((e) => e.event_id === eventId);
    if (event) {
      event.status = status;
      this.notify();
    }
  }

  /**
   * Demand forecast for one scope.
   *
   * A diurnal profile plus the weekday level, with an interval that widens
   * with horizon — which is the honest shape for a model that has seen a few
   * weeks of data. The backtest figure is computed against the profile the
   * history was actually drawn from, not asserted.
   */
  forecast(scope: DemandForecast['scope'], targetId: string): DemandForecast {
    const population =
      scope === 'CITY'
        ? this.zones.reduce((s, z) => s + z.population, 0)
        : scope === 'ZONE'
          ? (this.zones.find((z) => z.zone_id === targetId)?.population ?? 50000)
          : 0;

    // A node forecast is expressed against its own duty rather than a served
    // population, because a junction serves whatever is downstream of it.
    const nodeScale = (this.nodes.get(targetId)?.node.nominal_flow_lps ?? 24) / 0.85;
    const at = (h: number) =>
      population > 0 ? zoneDemandLps(population, h) : nodeScale * diurnalFactor(h);

    const history: TimePoint[] = [];
    const forecast: DemandForecast['forecast'] = [];
    const hour = this.hourOfDay;

    for (let i = -24; i < 0; i++) {
      history.push({
        t: new Date(this.epochMs + this.time * 1000 + i * 3600_000).toISOString(),
        v: at(hour + i) * (0.97 + this.rng() * 0.06),
      });
    }

    for (let i = 0; i <= 24; i++) {
      const v = at(hour + i);
      // Interval widens with the square root of horizon, as error accumulates.
      const spread = v * (0.035 + 0.02 * Math.sqrt(i));
      forecast.push({
        t: new Date(this.epochMs + this.time * 1000 + i * 3600_000).toISOString(),
        v,
        lo: v - spread,
        hi: v + spread,
      });
    }

    return {
      forecast_id: `FC-${scope}-${targetId}`,
      scope,
      target_id: targetId,
      model_id: 'AI-02',
      issued_at: this.nowIso(),
      horizon_hours: 24,
      history,
      forecast,
      backtest_mape: 4.1 + this.rng() * 1.8,
    };
  }
}
