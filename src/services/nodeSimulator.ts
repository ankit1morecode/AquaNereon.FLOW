import { deriveFieldParams, outletVelocityMs } from '../viz/core/fieldParams';
import { analyseRing, sampleRing, CHANNEL_COUNT } from '../viz/core/sensorRing';
import {
  buildSignature,
  captureBaseline,
  scoreFrame,
  PERSISTENCE_TAU,
  type Baseline,
} from '../viz/core/baseline';
import type { JunctionCondition } from '../viz/core/types';
import { makeRng } from '../viz/core/math';
import { findScenario, SyntheticFlowSource } from '../viz/data/SyntheticFlowSource';
import type {
  AquaNereonNode,
  FlowSignature,
  FlowState,
  HealthStatus,
  NodeHealth,
  SamplingMode,
  TelemetryFrame,
} from '../types';

/**
 * One simulated AquaNereon node.
 *
 * This is the reason the whole platform hangs together rather than being two
 * unrelated demos: it runs the **same** physics and measurement chain the 3D
 * view runs — the same velocity field, the same 16-element ring model, the
 * same baseline and the same four-state machine. A node's signature on the
 * City Command screen and the water in the Node Diagnostics viewport are two
 * renderings of one computation, not two mock datasets that happen to agree.
 *
 * Everything below the wire format is therefore inherited. What this class
 * adds is the parts a node has that a single junction does not: identity,
 * health, sampling mode, telemetry framing, and the closed-loop response to
 * commands (dossier §12).
 */

export interface NodeSimulatorOptions {
  node: AquaNereonNode;
  /** Which bundled scenario this node lives on. */
  scenario: 'NORMAL' | 'DRIFT' | 'DISTURBANCE';
  /** Seconds added to the scenario clock, so nodes are not in lockstep. */
  phase: number;
  /** Multiplier on branch flows, to give nodes different duty. */
  flowScale: number;
  seed: number;
}

/** Baselines are per-node data objects, but the capture condition is shared. */
const BASELINE_FOR_SCALE = new Map<number, Baseline>();

function baselineForScale(scale: number): Baseline {
  const key = Math.round(scale * 1000);
  const cached = BASELINE_FOR_SCALE.get(key);
  if (cached) return cached;
  const baseline = captureBaseline(`balanced-${key}`, {
    t: 0,
    inletA: { flowLps: 12 * scale, pressureKpa: 312, temperatureC: 21.4 },
    inletB: { flowLps: 12 * scale, pressureKpa: 310, temperatureC: 21.1 },
    downstreamRestriction: 0,
    noiseLevel: 0,
  });
  BASELINE_FOR_SCALE.set(key, baseline);
  return baseline;
}

/** Sampling mode the state machine asks for — the closed loop in §12. */
export function samplingForState(state: FlowState): SamplingMode {
  switch (state) {
    case 'STABLE':
      return 'NORMAL';
    case 'DRIFT':
      return 'INCREASED';
    case 'PRE_DISTURBANCE':
    case 'DISTURBANCE':
      return 'HIGH_RESOLUTION';
  }
}

export class NodeSimulator {
  readonly node: AquaNereonNode;
  readonly baseline: Baseline;

  state: FlowState = 'STABLE';
  previousState: FlowState = 'STABLE';
  stateSince = 0;
  samplingMode: SamplingMode = 'NORMAL';
  /** Set by a verification command; overrides the state-driven mode for a while. */
  private samplingOverrideUntil = 0;

  health: HealthStatus = 'OK';
  private faultUntil = 0;

  condition: JunctionCondition;
  signature: FlowSignature;

  private readonly source: SyntheticFlowSource;
  private readonly options: NodeSimulatorOptions;
  private readonly rng: () => number;
  private readonly channels = new Float32Array(CHANNEL_COUNT);
  private persistedDistance = 0;
  private lastDistance = 0;
  private time = 0;

  /** Rolling telemetry and signature windows, newest last. */
  readonly telemetry: TelemetryFrame[] = [];
  readonly signatures: FlowSignature[] = [];
  private static readonly TELEMETRY_KEEP = 240;
  private static readonly SIGNATURE_KEEP = 120;

  constructor(options: NodeSimulatorOptions) {
    this.options = options;
    this.node = options.node;
    this.rng = makeRng(options.seed);
    this.source = new SyntheticFlowSource(findScenario(options.scenario));
    this.baseline = baselineForScale(options.flowScale);

    this.condition = this.sampleCondition(0);
    this.signature = this.buildSignature(0);
  }

  /** Scenario condition, scaled to this node's duty. */
  private sampleCondition(t: number): JunctionCondition {
    const base = this.source.sample(t + this.options.phase);
    const s = this.options.flowScale;
    return {
      t,
      inletA: {
        flowLps: base.inletA.flowLps * s,
        pressureKpa: base.inletA.pressureKpa,
        temperatureC: base.inletA.temperatureC,
      },
      inletB: {
        flowLps: base.inletB.flowLps * s,
        pressureKpa: base.inletB.pressureKpa,
        temperatureC: base.inletB.temperatureC,
      },
      downstreamRestriction: base.downstreamRestriction,
      noiseLevel: base.noiseLevel,
    };
  }

  private buildSignature(t: number): FlowSignature {
    const F = deriveFieldParams(this.condition, t);
    sampleRing(F, this.condition.noiseLevel, this.channels);
    const frame = analyseRing(this.channels);
    this.lastDistance = scoreFrame(frame, this.baseline);

    const sig = buildSignature(
      frame,
      F.swirlNumber,
      this.persistedDistance,
      this.state,
    );

    const now = this.isoAt();
    const qa = this.dataQuality();

    return {
      signature_id: `SIG-${this.node.node_id}-${Math.round(t * 10)}`,
      node_id: this.node.node_id,
      timestamp: now,
      window_start: this.isoAt(-4),
      window_end: now,
      hydraulic: {
        flow_mean: this.condition.inletA.flowLps + this.condition.inletB.flowLps,
        flow_variation: Math.abs(
          this.condition.inletA.flowLps - this.condition.inletB.flowLps,
        ),
        pressure_mean:
          (this.condition.inletA.pressureKpa + this.condition.inletB.pressureKpa) / 2,
        pressure_variation: Math.abs(
          this.condition.inletA.pressureKpa - this.condition.inletB.pressureKpa,
        ),
        swirl_number: F.swirlNumber,
        axial_deficit: F.axialDeficit,
      },
      acoustic: {
        // Acoustic energy tracks turbulence intensity and through-flow, which
        // is the mechanism a hydrophone on the collar would actually respond to.
        rms: 0.02 + F.turbIntensity * 0.34 * Math.min(F.uOut / 4, 1.5),
        peak: 0.05 + F.turbIntensity * 0.7,
        dominant_hz: 120 + F.swirlNumber * 480 + F.axialDeficit * 260,
        spectral_energy: F.turbIntensity * F.turbIntensity * 2.4,
      },
      circumferential: {
        channel_features: Array.from(frame.channels),
        distribution_vector: Array.from(frame.distribution),
        asymmetry: frame.asymmetry,
        sector_imbalance: frame.sectorImbalance,
        spatial_gradient: frame.spatialGradient,
        modes: frame.modes,
        mode1_phase: frame.mode1Phase,
      },
      water_properties: {
        conductivity: 412 + this.rng() * 8,
        turbidity: 0.31 + F.turbIntensity * 0.9 + this.rng() * 0.04,
        temperature: this.condition.inletA.temperatureC,
      },
      temporal: {
        rate_of_change: this.rateOfChange,
        persistence: this.persistenceFraction,
        drift: this.persistedDistance,
        sudden_deviation: Math.abs(this.lastDistance - this.persistedDistance),
      },
      baseline_id: this.baseline.id,
      baseline_distance: this.persistedDistance,
      confidence: qa.confidence,
      data_quality: qa,
      state: sig.state,
    };
  }

  private rateOfChangeAcc = 0;
  private driftHistory: number[] = [];
  private stateHistory: FlowState[] = [];

  private get rateOfChange(): number {
    return this.rateOfChangeAcc;
  }

  private get persistenceFraction(): number {
    if (this.stateHistory.length === 0) return 0;
    const n = Math.min(this.stateHistory.length, 40);
    let count = 0;
    for (let i = this.stateHistory.length - n; i < this.stateHistory.length; i++) {
      if (this.stateHistory[i] !== 'STABLE') count++;
    }
    return count / n;
  }

  private dataQuality() {
    const offline = this.health === 'OFFLINE';
    const degraded = this.health === 'DEGRADED' || this.health === 'FAULT';
    return {
      completeness: offline ? 0 : degraded ? 0.72 : 0.98 + this.rng() * 0.02,
      confidence: offline ? 0 : degraded ? 0.55 : 0.88 + this.rng() * 0.1,
      stale: offline,
      suspect_channels: degraded ? [3, 4] : [],
    };
  }

  /**
   * Telemetry timestamps are real wall-clock, not simulated time.
   *
   * The platform runs its calendar fast so a whole demand day passes in a few
   * minutes, but a frame that was produced a second ago has to be stamped a
   * second ago — otherwise every "3s ago" in the interface races into the
   * future and reads as broken. The accelerated clock belongs to the demand
   * model; the telemetry clock belongs to the feed.
   */
  private isoAt(offsetSec = 0): string {
    return new Date(Date.now() + offsetSec * 1000).toISOString();
  }

  /** Advance the node by `dt` simulated seconds. */
  step(dt: number): void {
    this.time += dt;

    // Rare, self-clearing faults, so health is not decoration.
    if (this.time > this.faultUntil && this.rng() < 0.00025 * dt * 60) {
      this.faultUntil = this.time + 20 + this.rng() * 40;
      this.health = this.rng() < 0.3 ? 'OFFLINE' : 'DEGRADED';
    } else if (this.time > this.faultUntil && this.health !== 'OK') {
      this.health = 'OK';
    }

    this.condition = this.sampleCondition(this.time);

    const previousDistance = this.persistedDistance;
    const F = deriveFieldParams(this.condition, this.time);
    sampleRing(F, this.condition.noiseLevel, this.channels);
    const frame = analyseRing(this.channels);
    const instant = scoreFrame(frame, this.baseline);
    this.persistedDistance += (instant - this.persistedDistance) * (1 - Math.exp(-dt / PERSISTENCE_TAU));
    this.rateOfChangeAcc = dt > 0 ? (this.persistedDistance - previousDistance) / dt : 0;

    const next = buildSignature(frame, F.swirlNumber, this.persistedDistance, this.state);
    if (next.state !== this.state) {
      this.previousState = this.state;
      this.state = next.state;
      this.stateSince = this.time;
    }

    this.stateHistory.push(this.state);
    if (this.stateHistory.length > 80) this.stateHistory.shift();
    this.driftHistory.push(this.persistedDistance);
    if (this.driftHistory.length > 80) this.driftHistory.shift();

    // Closed loop: the software asks for more resolution when the evidence is
    // thin, unless an operator command has taken control of the mode.
    if (this.time > this.samplingOverrideUntil) {
      this.samplingMode = samplingForState(this.state);
    }

    this.signature = this.buildSignature(this.time);
    this.pushTelemetry(F.uOut, outletVelocityMs(this.condition));
    this.pushSignature();
  }

  private pushTelemetry(_uOut: number, outletMs: number): void {
    const qa = this.dataQuality();
    const frame: TelemetryFrame = {
      node_id: this.node.node_id,
      timestamp: this.isoAt(),
      flow: {
        a: this.condition.inletA.flowLps,
        b: this.condition.inletB.flowLps,
        out: this.condition.inletA.flowLps + this.condition.inletB.flowLps,
      },
      pressure: {
        a: this.condition.inletA.pressureKpa,
        b: this.condition.inletB.pressureKpa,
        // Outlet pressure falls with dynamic head and with any restriction.
        out:
          (this.condition.inletA.pressureKpa + this.condition.inletB.pressureKpa) / 2 -
          18 -
          this.condition.downstreamRestriction * 95,
      },
      acoustic_rms: this.signature.acoustic.rms,
      conductivity_us_cm: this.signature.water_properties.conductivity,
      turbidity_ntu: this.signature.water_properties.turbidity,
      temperature_c: this.condition.inletA.temperatureC,
      circumferential_channels: Array.from(this.channels),
      data_quality: qa,
    };
    void outletMs;
    this.telemetry.push(frame);
    if (this.telemetry.length > NodeSimulator.TELEMETRY_KEEP) this.telemetry.shift();
  }

  private pushSignature(): void {
    this.signatures.push(this.signature);
    if (this.signatures.length > NodeSimulator.SIGNATURE_KEEP) this.signatures.shift();
  }

  get health_report(): NodeHealth {
    const offline = this.health === 'OFFLINE';
    return {
      node_id: this.node.node_id,
      timestamp: this.isoAt(),
      sensor_status: this.health === 'DEGRADED' ? 'DEGRADED' : offline ? 'OFFLINE' : 'OK',
      power_status: 'OK',
      communication_status: offline ? 'OFFLINE' : 'OK',
      calibration_status: 'OK',
      telemetry_age_sec: offline ? Math.min(this.faultUntil - this.time, 60) : 0.5,
      packet_loss: offline ? 1 : this.health === 'DEGRADED' ? 0.14 : 0.001,
      battery_pct: 100,
      rssi_dbm: offline ? -110 : -62 - Math.round(this.rng() * 8),
    };
  }

  /** Anomaly score: normalised baseline distance, which is what drives state. */
  get anomalyScore(): number {
    return Math.min(1, this.persistedDistance / 0.28);
  }

  get outletFlowLps(): number {
    return this.condition.inletA.flowLps + this.condition.inletB.flowLps;
  }

  get lastSeen(): string {
    return this.isoAt();
  }

  /** Apply an operator sampling command; it holds for its stated duration. */
  applySampling(mode: SamplingMode, durationSec = 120): void {
    this.samplingMode = mode;
    this.samplingOverrideUntil = this.time + durationSec;
  }

  /** Force the node into a scenario position, for the Reports replay. */
  seek(seconds: number): void {
    this.time = Math.max(0, seconds);
    this.condition = this.sampleCondition(this.time);
    this.signature = this.buildSignature(this.time);
  }
}
