import type { Vec3 } from './math';

/* ================================================================== */
/* 1. INPUT CONTRACT — what drives the visualization                   */
/* ================================================================== */

/** Measured (or synthesised) condition of one inlet branch. */
export interface InletCondition {
  /** Volumetric flow rate, litres per second. */
  flowLps: number;
  /** Gauge pressure, kPa. Carried for completeness; not used by the field. */
  pressureKpa: number;
  /** Water temperature, degrees C. Carried for completeness. */
  temperatureC: number;
}

/**
 * The complete boundary condition of the hydraulic junction at one instant.
 * This is the ONLY thing the flow field reads. Replace the synthetic source
 * with a live AquaNereon node feed and nothing downstream has to change.
 */
export interface JunctionCondition {
  /** Seconds since the start of the run. */
  t: number;
  inletA: InletCondition;
  inletB: InletCondition;
  /**
   * Downstream obstruction, 0 = clear .. 1 = heavily restricted.
   * Maps to the dossier's operating_context.valve_state.
   */
  downstreamRestriction: number;
  /** Broadband measurement noise level, 0..1. */
  noiseLevel: number;
}

/* ================================================================== */
/* 2. DERIVED FIELD PARAMETERS                                         */
/* ================================================================== */

/**
 * Everything the velocity field needs, computed once per frame from a
 * JunctionCondition. Kept as a flat struct so the per-particle inner loop
 * touches no getters and allocates nothing.
 */
export interface FieldParams {
  /** Bulk axial speed in each inlet pipe, world units/s. */
  uA: number;
  uB: number;
  /** Bulk axial speed in the outlet pipe, world units/s. */
  uOut: number;
  /** Total volumetric flow, world units^3/s. */
  qTotal: number;

  /** Swirl number S = angular momentum flux / (R * axial momentum flux). */
  swirlNumber: number;
  /** Circulation of the vortex, world units^2/s. */
  circulation: number;
  /** Lamb-Oseen core radius, world units. */
  coreRadius: number;

  /** Time-mean lateral displacement of the vortex core at the chamber exit. */
  coreOffsetY: number;
  coreOffsetZ: number;
  /**
   * Lean of the axial momentum profile: the direction and degree to which the
   * high-momentum side of the column is displaced when the branches are
   * unbalanced. Linear in position, so it redistributes flux without adding
   * any, and it is the dominant thing the sensor ring actually reads.
   */
  leanY: number;
  leanZ: number;
  /** Precessing-vortex-core helix amplitude (world units) and rates. */
  precessAmp: number;
  precessOmega: number;
  precessK: number;

  /** Axial velocity deficit on the core. > 1 produces a recirculation bubble. */
  axialDeficit: number;
  /** Normalised shear between the two inlet streams. */
  shear: number;
  /** Turbulence intensity multiplier. */
  turbIntensity: number;

  /** Seconds, already scaled for display. */
  time: number;
}

/* ================================================================== */
/* 3. OUTPUT CONTRACT — what the sensor ring reports                   */
/* ================================================================== */

export type FlowState = 'STABLE' | 'DRIFT' | 'PRE_DISTURBANCE' | 'DISTURBANCE';

/**
 * One frame from the circumferential sensor ring, reduced to the
 * spatial feature group named in the software dossier
 * (mean, variance, max-min, asymmetry, sector imbalance, spatial gradients).
 */
export interface CircumferentialFrame {
  /** Raw per-channel response, length = GEO.sensorChannels. */
  channels: Float32Array;
  /** Channels normalised to unit mean — the comparable distribution vector. */
  distribution: Float32Array;
  mean: number;
  variance: number;
  maxMinusMin: number;
  /** |sum of channel vectors| / sum of magnitudes. 0 = perfectly even ring. */
  asymmetry: number;
  /** (max - min) / mean. */
  sectorImbalance: number;
  /** Mean absolute difference between adjacent channels. */
  spatialGradient: number;
  /** First three circumferential Fourier modes of the distribution. */
  modes: [number, number, number];
  /** Azimuth (radians) of the mode-1 maximum — where the core has moved. */
  mode1Phase: number;
}

/**
 * The flow fingerprint: a circumferential frame scored against a stored
 * baseline and classified by the four-state machine.
 */
export interface FlowSignature extends CircumferentialFrame {
  swirlNumber: number;
  /** L2 distance between this distribution vector and the baseline's. */
  baselineDistance: number;
  state: FlowState;
}

/* ================================================================== */
/* 4. DATA SOURCE INTERFACE — the replacement seam                     */
/* ================================================================== */

/**
 * Anything that can tell the visualization what the junction is doing.
 *
 * SyntheticFlowSource replays a bundled dataset. A future LiveSensorSource
 * would hold the newest AquaNereonNode telemetry frame and return it here.
 * The scene never learns which one it is talking to.
 */
export interface FlowDataSource {
  readonly id: string;
  readonly label: string;
  /** Total dataset length in seconds, or null for an open-ended live feed. */
  readonly durationSec: number | null;
  /** Condition at absolute time t (seconds). */
  sample(t: number): JunctionCondition;
}

export type { Vec3 };
