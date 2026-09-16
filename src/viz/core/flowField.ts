import { CHAMBER_IN_X, GEO } from '../config/geometry';
import {
  coreGrowthAt,
  coreRelaxAt,
  makeAxialSample,
  sampleAxial,
  wallRadiusAt,
} from './axialProfile';
import { PORT_A, PORT_B, type InletPort } from './junctionPorts';
import { fastSin, smoothstep, type Vec3 } from './math';
import { addTurbulence } from './turbulence';
import type { FieldParams } from './types';

/**
 * Analytic velocity field for the AquaNereon hydraulic junction.
 *
 * Structure, upstream to downstream:
 *
 *   1. Two straight inlet runs carrying a blunt turbulent pipe profile.
 *   2. A chamber where the two jets penetrate, spread and lose their identity
 *      into a common swirling column.
 *   3. A contraction into the outlet, where continuity accelerates the flow.
 *   4. A swirling outlet column: Lamb-Oseen tangential profile about a
 *      precessing core, with an axial deficit on that core.
 *
 * The field is steady in form and unsteady only through the precession phase
 * and the turbulence term, which is what a phenomenological model can honestly
 * offer. It is not a CFD solution, but every term corresponds to a real
 * mechanism, so the picture responds to an inlet change the way the hardware
 * would rather than the way an animation curve would.
 *
 * Everything that depends only on x lives in axialProfile.ts as a table; what
 * is left here is the part that genuinely varies with the flow condition.
 */

/** Jet spreading half-width at the port, and its growth rate with distance. */
const JET_SIGMA0 = GEO.pipeRadius * 0.95;
const JET_SPREAD = 0.42;

/**
 * Integral of the wall profile over the unit disc: 2 * int_0^1 (1 - 0.3 r^5) r dr.
 * Used to renormalise the axial profile so it carries exactly the bulk flux.
 */
const WALL_PROFILE_INTEGRAL = 1 - (0.3 * 2) / 7;

/** x beyond which the inlet jets have died and can be skipped entirely. */
const JET_CUTOFF_WEIGHT = 0.01;

export { wallRadiusAt };

/** Lateral position of the vortex core at station x and time t. */
export function coreCenterAt(
  x: number,
  F: FieldParams,
  out: { y: number; z: number },
): void {
  const grow = coreGrowthAt(x);
  const relax = coreRelaxAt(x);
  const phase = F.precessOmega * F.time - F.precessK * x;
  const amp = F.precessAmp * grow;

  out.y = F.coreOffsetY * relax * grow + amp * fastSin(phase + Math.PI / 2);
  out.z = F.coreOffsetZ * relax * grow + amp * fastSin(phase);
}

const tmpCore = { y: 0, z: 0 };
const axial = makeAxialSample();

/* ------------------------------------------------------------------ */
/* Inlet pipe flow                                                     */
/* ------------------------------------------------------------------ */

function inletVelocity(
  out: Vec3,
  px: number,
  py: number,
  pz: number,
  port: InletPort,
  bulk: number,
): void {
  const d = port.direction;
  const ox = px - port.origin.x;
  const oy = py - port.origin.y;
  const oz = pz - port.origin.z;
  const s = ox * d.x + oy * d.y + oz * d.z;
  const rx = ox - s * d.x;
  const ry = oy - s * d.y;
  const rz = oz - s * d.z;
  // Clamped at the wall: points outside the bore are not physical, but the
  // field still has to stay bounded there because streamlines and diagnostics
  // can sample anywhere.
  const r2 = Math.min((rx * rx + ry * ry + rz * rz) / (GEO.pipeRadius * GEO.pipeRadius), 1);
  // Blunt turbulent profile rather than parabolic: real pipe flow at these
  // Reynolds numbers is nearly flat in the core with a thin wall layer.
  const u = bulk * (1 - 0.34 * r2 * r2);
  out.x = u * d.x;
  out.y = u * d.y;
  out.z = u * d.z;
}

/** Squared perpendicular distance from a point to a port's jet axis. */
function jetDistanceSq(px: number, py: number, pz: number, port: InletPort): number {
  const d = port.direction;
  const ox = px - port.position.x;
  const oy = py - port.position.y;
  const oz = pz - port.position.z;
  const s = Math.max(0, ox * d.x + oy * d.y + oz * d.z);
  const rx = ox - s * d.x;
  const ry = oy - s * d.y;
  const rz = oz - s * d.z;
  return rx * rx + ry * ry + rz * rz;
}

/** Distance travelled along a port's jet axis. */
function jetArc(px: number, py: number, pz: number, port: InletPort): number {
  const d = port.direction;
  return Math.max(
    0,
    (px - port.position.x) * d.x +
      (py - port.position.y) * d.y +
      (pz - port.position.z) * d.z,
  );
}

/* ------------------------------------------------------------------ */
/* Swirling column (chamber + outlet)                                  */
/* ------------------------------------------------------------------ */

function columnVelocity(
  out: Vec3,
  px: number,
  py: number,
  pz: number,
  F: FieldParams,
): void {
  const R = axial.wallR;

  // Continuity sets the bulk axial speed: narrowing bore, faster water.
  const uBulk = F.qTotal * axial.invArea;

  const r2Axis = py * py + pz * pz;
  const rAxis = Math.sqrt(r2Axis);
  const rn = Math.min(rAxis / R, 1);

  coreCenterAt(px, F, tmpCore);
  const cy = py - tmpCore.y;
  const cz = pz - tmpCore.z;
  const rho2 = cy * cy + cz * cz;

  const rc2 = F.coreRadius * F.coreRadius;
  // One exponential serves both the axial deficit and the Lamb-Oseen profile.
  const gauss = Math.exp(-rho2 / rc2);

  // --- axial ---------------------------------------------------------
  // Near-wall slowdown about the pipe axis...
  const rn2 = rn * rn;
  const wallProfile = 1 - 0.3 * rn2 * rn2 * rn;
  // ...and a deficit centred on the vortex core. Once the deficit exceeds the
  // through-flow this goes negative and a recirculation bubble opens: the
  // classic vortex-breakdown signature, which reads on screen as water
  // stalling and tumbling backwards on the axis.
  const deficit = F.axialDeficit * gauss;

  // Mass has to be conserved, and where the compensating flux goes decides
  // whether breakdown can happen at all. Boosting the whole profile uniformly
  // would raise the core along with everything else and the axis could never
  // reverse however strong the deficit got. So the compensation is applied
  // only outside the core — shaped by (1 - gauss) — which is also what really
  // happens: the blocked core squeezes the through-flow into an annulus.
  //
  // With the disc integrals of both shapes known exactly, the annular boost
  // that restores the bulk flux is
  //     A = (1 - I_wall + D k) / (I_wall - k),   k = (rc/R)^2
  const k = Math.min(rc2 / (R * R), 0.8);
  const annulusBoost = Math.min(
    (1 - WALL_PROFILE_INTEGRAL + F.axialDeficit * k) / (WALL_PROFILE_INTEGRAL - k),
    2.5,
  );

  // Momentum lean: with unbalanced branches the high-momentum side of the
  // column is displaced sideways, and it stays displaced well downstream. The
  // term is linear in position, so it integrates to zero over the section and
  // moves flux around without creating any.
  const lean = ((py * F.leanY + pz * F.leanZ) / R) * axial.leanDecay;

  const ux =
    uBulk * (wallProfile * (1 + annulusBoost * (1 - gauss)) - deficit) * (1 + lean);

  // --- radial: follow the wall ---------------------------------------
  const ur = ux * axial.wallSlope * rn;
  const invR = rAxis > 1e-6 ? 1 / rAxis : 0;

  // --- tangential: Lamb-Oseen about the core -------------------------
  const gamma = F.circulation * axial.circShape;
  let vTheta = 0;
  let invRho = 0;
  if (rho2 > 1e-10) {
    invRho = 1 / Math.sqrt(rho2);
    if (gamma !== 0) vTheta = (gamma / (2 * Math.PI)) * invRho * (1 - gauss);
  }
  // Tangential unit vector about the core: xHat x (p - core).
  const tY = -cz * invRho;
  const tZ = cy * invRho;

  out.x = ux;
  out.y = ur * py * invR + vTheta * tY;
  out.z = ur * pz * invR + vTheta * tZ;
}

/* ------------------------------------------------------------------ */
/* Assembled field                                                     */
/* ------------------------------------------------------------------ */

const tmpInlet: Vec3 = { x: 0, y: 0, z: 0 };
const tmpJet: Vec3 = { x: 0, y: 0, z: 0 };
const tmpCol: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Sample the velocity field at a point, in world units per second.
 *
 * @param originHint 0 = came from inlet A, 1 = came from inlet B, -1 = unknown.
 *                   Only consulted upstream of the chamber, where the two pipes
 *                   are separate volumes and a point's pipe is not determined by
 *                   its position alone.
 */
export function sampleVelocity(
  out: Vec3,
  px: number,
  py: number,
  pz: number,
  F: FieldParams,
  originHint: number,
): void {
  const inChamber = smoothstep(CHAMBER_IN_X - 0.75, CHAMBER_IN_X + 0.65, px);

  if (inChamber < 1) {
    let port = PORT_A;
    let bulk = F.uA;
    if (originHint >= 0.5) {
      port = PORT_B;
      bulk = F.uB;
    } else if (originHint < 0) {
      if (jetDistanceSq(px, py, pz, PORT_B) < jetDistanceSq(px, py, pz, PORT_A)) {
        port = PORT_B;
        bulk = F.uB;
      }
    }
    inletVelocity(tmpInlet, px, py, pz, port, bulk);
    if (inChamber <= 0) {
      out.x = tmpInlet.x;
      out.y = tmpInlet.y;
      out.z = tmpInlet.z;
      addTurbulence(out, px, py, pz, F.time, F.turbIntensity * 0.1 * bulk);
      return;
    }
  }

  sampleAxial(px, axial);
  columnVelocity(tmpCol, px, py, pz, F);

  // Jet residual: near the ports the two streams still exist as streams, and
  // this is the region where "two flows interact" is literally visible.
  const jetW = axial.jetWeight;
  if (jetW > JET_CUTOFF_WEIGHT) {
    const sigA = JET_SIGMA0 * (1 + JET_SPREAD * jetArc(px, py, pz, PORT_A));
    const sigB = JET_SIGMA0 * (1 + JET_SPREAD * jetArc(px, py, pz, PORT_B));
    const wA = F.uA * Math.exp(-jetDistanceSq(px, py, pz, PORT_A) / (sigA * sigA));
    const wB = F.uB * Math.exp(-jetDistanceSq(px, py, pz, PORT_B) / (sigB * sigB));

    // Momentum-weighted blend of the two jets against the column. This is a
    // redistribution, not an addition, so the junction never manufactures flux
    // that continuity did not put there.
    const eps = 0.25 * (F.uOut + 1e-6);
    const inv = 1 / (wA + wB + eps);
    const dA = PORT_A.direction;
    const dB = PORT_B.direction;
    tmpJet.x = (wA * F.uA * dA.x + wB * F.uB * dB.x + eps * tmpCol.x) * inv;
    tmpJet.y = (wA * F.uA * dA.y + wB * F.uB * dB.y + eps * tmpCol.y) * inv;
    tmpJet.z = (wA * F.uA * dA.z + wB * F.uB * dB.z + eps * tmpCol.z) * inv;

    out.x = tmpCol.x + (tmpJet.x - tmpCol.x) * jetW;
    out.y = tmpCol.y + (tmpJet.y - tmpCol.y) * jetW;
    out.z = tmpCol.z + (tmpJet.z - tmpCol.z) * jetW;
  } else {
    out.x = tmpCol.x;
    out.y = tmpCol.y;
    out.z = tmpCol.z;
  }

  // Blend against the inlet-pipe solution across the chamber face.
  if (inChamber < 1) {
    out.x = tmpInlet.x + (out.x - tmpInlet.x) * inChamber;
    out.y = tmpInlet.y + (out.y - tmpInlet.y) * inChamber;
    out.z = tmpInlet.z + (out.z - tmpInlet.z) * inChamber;
  }

  addTurbulence(
    out,
    px,
    py,
    pz,
    F.time,
    F.turbIntensity * axial.turbMask * 0.14 * F.uOut,
  );
}

/**
 * Hard wall confinement. Pulls a point back inside the bore it belongs to,
 * so tracer particles stay inside the pipe that is drawn around them.
 */
export function confine(p: Vec3, originHint: number): void {
  if (p.x < CHAMBER_IN_X + 0.15) {
    const port = originHint >= 0.5 ? PORT_B : PORT_A;
    const d = port.direction;
    const ox = p.x - port.origin.x;
    const oy = p.y - port.origin.y;
    const oz = p.z - port.origin.z;
    const s = ox * d.x + oy * d.y + oz * d.z;
    const rx = ox - s * d.x;
    const ry = oy - s * d.y;
    const rz = oz - s * d.z;
    const r = Math.sqrt(rx * rx + ry * ry + rz * rz);
    const lim = GEO.pipeRadius * 0.955;
    if (r > lim) {
      const k = lim / r;
      p.x = port.origin.x + s * d.x + rx * k;
      p.y = port.origin.y + s * d.y + ry * k;
      p.z = port.origin.z + s * d.z + rz * k;
    }
    return;
  }

  const lim = wallRadiusAt(p.x) * 0.955;
  const r = Math.sqrt(p.y * p.y + p.z * p.z);
  if (r > lim) {
    const k = lim / r;
    p.y *= k;
    p.z *= k;
  }
}
