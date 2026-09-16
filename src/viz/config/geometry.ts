/**
 * AquaNereon.FLOW — hydraulic junction geometry.
 *
 * Single source of truth. Both the rendered meshes and the analytic flow field
 * are derived from these numbers, so the water always moves inside the pipes
 * that are drawn on screen.
 *
 * World units: 1 unit = 0.1 m (see METERS_PER_UNIT). The junction axis is +X,
 * flow travels from -X (inlets) to +X (outlet).
 */

export const METERS_PER_UNIT = 0.1;

/**
 * Display slow-motion factor. The field is evaluated in real m/s and then
 * scaled for playback, because a 2 m/s outlet would cross the visible pipe run
 * in under half a second. This is a viewing convenience, not a physics change.
 */
export const DISPLAY_TIME_SCALE = 0.22;

/** m/s -> world units/s */
export const VELOCITY_TO_WORLD = (1 / METERS_PER_UNIT) * DISPLAY_TIME_SCALE;

export const GEO = {
  /** Inner radius of the inlet and outlet pipes (world units). */
  pipeRadius: 0.62,
  /** Pipe wall thickness, drawn only. */
  wallThickness: 0.07,

  /** Inner radius of the cylindrical junction chamber. */
  junctionRadius: 1.24,
  /** Chamber spans x in [-junctionHalfLength, +junctionHalfLength]. */
  junctionHalfLength: 1.6,

  /** Straight run length of each inlet pipe, measured back from its port. */
  inletLength: 6.4,
  /** Straight run length of the outlet pipe, measured from the chamber face. */
  outletLength: 8.6,

  /**
   * Inlet port placement on the upstream chamber face, in the Y-Z plane.
   * The ports are point-symmetric about the axis: port A at (+y, +z),
   * port B at (-y, -z). The z offset is what makes the two streams
   * tangential rather than purely radial, so they inject angular momentum
   * about the outlet axis. That is the geometric origin of the vortex.
   */
  portOffsetY: 0.5,
  portOffsetZ: 0.42,

  /**
   * Inlet direction basis weights, applied to (axial, -radial, tangential)
   * unit vectors at the port. Tuned so the pipes read as a converging Y with a
   * visible tangential stagger.
   */
  inletAxialWeight: 0.8,
  inletRadialWeight: 0.42,
  inletTangentialWeight: 0.34,

  /** Axial station of the circumferential sensor ring, in the outlet run. */
  sensorRingX: 3.3,
  /** Number of circumferential channels on the ring. */
  sensorChannels: 16,
} as const;

/** x of the upstream chamber face (where the inlet ports sit). */
export const CHAMBER_IN_X = -GEO.junctionHalfLength;
/** x of the downstream chamber face (where the outlet leaves). */
export const CHAMBER_OUT_X = GEO.junctionHalfLength;
/** x where the visible outlet pipe ends and particles are recycled. */
export const OUTLET_END_X = CHAMBER_OUT_X + GEO.outletLength;

export const PIPE_AREA_M2 = Math.PI * (GEO.pipeRadius * METERS_PER_UNIT) ** 2;
export const PIPE_RADIUS_M = GEO.pipeRadius * METERS_PER_UNIT;

/** Design total throughput, L/s. Used to calibrate tracer seeding. */
export const NOMINAL_TOTAL_FLOW_LPS = 24;
/** Outlet bulk speed at the design flow, world units/s. */
export const NOMINAL_OUTLET_SPEED =
  (NOMINAL_TOTAL_FLOW_LPS / 1000 / PIPE_AREA_M2) * VELOCITY_TO_WORLD;
