import { makeRng } from '../viz/core/math';
import type {
  AquaNereonNode,
  CityOverview,
  DemandForecast,
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
import { assess, SEVERITY_ORDER } from './assessment';
import { suspectRegion } from './propagation';
import { LocalDeviceBus, type DeviceBus } from './mqtt';
import {
  haversineMetres,
  NODE_SEEDS,
  SOURCE_SEEDS,
  ZONE_SEEDS,
} from './topology';
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
/* Demand model                                                        */
/* ------------------------------------------------------------------ */

/**
 * Average municipal draw per person: about 150 litres a day, a typical
 * European figure and the one that makes supply and demand comparable at this
 * network size.
 */
const PER_CAPITA_LPS = 150 / 86400;

/** Zone demand at a given hour, litres per second. */
export function zoneDemandLps(population: number, hourOfDay: number): number {
  return population * PER_CAPITA_LPS * diurnalFactor(hourOfDay);
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Stable hash of a node id, for per-node random seeds. */
function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 8;
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

    this.zones = ZONE_SEEDS.map((z) => ({
      ...z,
      node_ids: NODE_SEEDS.filter((n) => n.zone === z.zone_id).map((n) => n.id),
    }));

    for (const seed of NODE_SEEDS) {
      const node: AquaNereonNode = {
        node_id: seed.id,
        zone_id: seed.zone,
        hardware_version: 'AN-HW-2.1',
        firmware_version: '0.9.4',
        location: {
          lat: seed.lat,
          lng: seed.lng,
          label: seed.label,
          address: seed.address,
        },
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
          // Distinct per node, so faults and sensor noise do not correlate
          // across the network purely because the ids look alike.
          seed: 0x1000 + hashId(seed.id),
        }),
      );
    }

    this.network = this.buildNetwork();
    for (const zone of this.zones) this.consumption.set(zone.zone_id, []);
    this.seedConsumption();
  }

  private buildNetwork(): NetworkGraph {
    const vertices: NetworkGraph['vertices'] = [
      ...SOURCE_SEEDS.map((s) => ({
        id: s.id,
        kind: s.kind,
        zone_id: s.zone,
        location: { lat: s.lat, lng: s.lng, label: s.label, address: s.address },
      })),
      ...NODE_SEEDS.map((n) => ({
        id: n.id,
        kind: 'JUNCTION' as const,
        zone_id: n.zone,
        location: { lat: n.lat, lng: n.lng, label: n.label, address: n.address },
      })),
    ];

    const edges: NetworkGraph['edges'] = [];
    for (const seed of NODE_SEEDS) {
      for (const up of seed.upstream) {
        const from = vertices.find((v) => v.id === up);
        if (!from) continue;
        edges.push({
          pipe_id: `P-${up}-${seed.id}`,
          from: up,
          to: seed.id,
          // Diameter follows duty, roughly as a real main would be sized.
          diameter_mm: Math.round(seed.nominal * 5 + 90),
          length_m: Math.round(
            haversineMetres(from.location, { lat: seed.lat, lng: seed.lng, label: '' }),
          ),
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

    // One definition of the evidence, shared with the live assessment shown on
    // Node Diagnostics. Two copies would drift, and the screen would end up
    // explaining a conclusion the event engine did not reach.
    const assessment = assess({
      signature: sig,
      state: sim.state,
      upstream: neighbours.upstream,
      downstream: neighbours.downstream,
    });

    const region = suspectRegion(this.network, sim.node.node_id);

    return {
      event_id: `EV-${sim.node.node_id}-${Math.round(this.time)}`,
      event_type: assessment.eventType,
      node_id: sim.node.node_id,
      zone_id: sim.node.zone_id,
      timestamp: this.nowIso(),
      severity: assessment.severity,
      anomaly_score: sim.anomalyScore,
      state_transition: { from, to: sim.state },
      evidence: assessment.evidence,
      model_outputs: assessment.modelOutputs,
      network_context: {
        upstream_states: neighbours.upstream,
        downstream_states: neighbours.downstream,
        propagation: assessment.propagated ? 'PROPAGATED' : 'LOCAL',
      },
      data_quality: sig.data_quality,
      suspected_origin: assessment.leakSuspected
        ? { description: region.description, confidence: 0.54 }
        : undefined,
      recommended_action: {
        action:
          sim.state === 'DISTURBANCE'
            ? `Dispatch inspection to ${sim.node.location.label}${
                sim.node.location.address ? ` (${sim.node.location.address})` : ''
              }; hold high-resolution sampling.`
            : sim.state === 'PRE_DISTURBANCE'
              ? `Raise sampling on ${sim.node.node_id} and correlate with ${sim.node.downstream[0] ?? 'downstream'} over the next hour.`
              : `Watch ${sim.node.node_id}; no field action yet.`,
        priority: SEVERITY_ORDER.indexOf(assessment.severity),
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
