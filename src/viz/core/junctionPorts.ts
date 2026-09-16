import { GEO, CHAMBER_IN_X, METERS_PER_UNIT } from '../config/geometry';
import { normalizeInto, v3, type Vec3 } from './math';

/**
 * Static description of the two inlet ports.
 *
 * Each port sits off-axis in BOTH y and z on the upstream chamber face, and
 * each inlet direction carries a tangential component. That tangential term
 * is the only reason this junction swirls at all: two purely radial streams
 * would meet head-on and produce no net angular momentum about the outlet
 * axis. Offsetting them turns the chamber into a swirl generator, which is
 * what makes the vortex an emergent property of the geometry instead of an
 * animation parameter.
 */
export interface InletPort {
  id: 'A' | 'B';
  /** Port centre on the chamber face (world units). */
  position: Vec3;
  /** Unit flow direction at the port, pointing into the chamber. */
  direction: Vec3;
  /** Upstream end of the straight pipe run. */
  origin: Vec3;
  /**
   * Specific angular momentum about the +X axis carried per unit momentum
   * flux, i.e. (r x d).x with r in metres. Positive = co-rotating.
   */
  specificSwirl: number;
}

function buildPort(id: 'A' | 'B', sign: number): InletPort {
  const py = GEO.portOffsetY * sign;
  const pz = GEO.portOffsetZ * sign;

  // Radial and tangential unit vectors at the port, in the Y-Z plane.
  const rl = Math.hypot(py, pz) || 1;
  const rY = py / rl;
  const rZ = pz / rl;
  // tangential = xHat x radial
  const tY = -rZ;
  const tZ = rY;

  const direction = normalizeInto(
    v3(),
    GEO.inletAxialWeight,
    -GEO.inletRadialWeight * rY + GEO.inletTangentialWeight * tY,
    -GEO.inletRadialWeight * rZ + GEO.inletTangentialWeight * tZ,
  );

  const position = v3(CHAMBER_IN_X, py, pz);
  const origin = v3(
    position.x - direction.x * GEO.inletLength,
    position.y - direction.y * GEO.inletLength,
    position.z - direction.z * GEO.inletLength,
  );

  // (r x d).x = r.y * d.z - r.z * d.y, with r in metres.
  const specificSwirl =
    py * METERS_PER_UNIT * direction.z - pz * METERS_PER_UNIT * direction.y;

  return { id, position, direction, origin, specificSwirl };
}

export const PORT_A = buildPort('A', +1);
export const PORT_B = buildPort('B', -1);
export const PORTS: readonly InletPort[] = [PORT_A, PORT_B];
