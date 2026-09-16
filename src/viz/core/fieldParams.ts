import {
  GEO,
  PIPE_AREA_M2,
  PIPE_RADIUS_M,
  VELOCITY_TO_WORLD,
} from '../config/geometry';
import { PORT_A, PORT_B } from './junctionPorts';
import { clamp, smoothstep } from './math';
import type { FieldParams, JunctionCondition } from './types';

/**
 * Turn a measured junction condition into the parameters of the velocity
 * field.
 *
 * Everything here follows from momentum bookkeeping at the two inlet ports.
 * Nothing about the vortex is authored by hand: its strength, its lateral
 * position and its stability all fall out of how much momentum each branch
 * delivers and in which direction.
 */

/** Momentum flux per unit density for one branch: Q * U  [m^4/s^2]. */
function momentumFlux(flowLps: number): number {
  const q = Math.max(flowLps, 0) / 1000; // m^3/s
  return q * (q / PIPE_AREA_M2);
}

/* ---- Tuning constants -------------------------------------------------
 * These set how strongly each physical driver expresses itself visually.
 * They are display gains, not claims about a specific real junction.
 * ---------------------------------------------------------------------- */
const CORE_OFFSET_GAIN = 1.1;       // lateral core shift per unit momentum bias
const MAX_CORE_OFFSET = 0.46;       // fraction of pipe radius
const LEAN_GAIN = 0.68;             // momentum-profile lean per unit momentum bias
const MAX_LEAN = 0.55;
const SWIRL_TO_TANGENTIAL = 1.15;   // peak v_theta / u_out per unit swirl number
const BREAKDOWN_ONSET = 0.30;       // swirl number at which a core deficit starts
const BREAKDOWN_GAIN = 1.25;
const RESTRICTION_GAIN = 1.5;       // adverse pressure gradient promotes breakdown
const SHEAR_GAIN = 0.35;

export function deriveFieldParams(
  cond: JunctionCondition,
  displayTime: number,
): FieldParams {
  const qA = Math.max(cond.inletA.flowLps, 0);
  const qB = Math.max(cond.inletB.flowLps, 0);
  const qSum = qA + qB;

  // Bulk speeds, m/s then world units/s.
  const uA_ms = qA / 1000 / PIPE_AREA_M2;
  const uB_ms = qB / 1000 / PIPE_AREA_M2;
  const uOut_ms = qSum / 1000 / PIPE_AREA_M2;

  const uA = uA_ms * VELOCITY_TO_WORLD;
  const uB = uB_ms * VELOCITY_TO_WORLD;
  const uOut = uOut_ms * VELOCITY_TO_WORLD;

  // Volumetric flow expressed in the scene's own units, so that
  // u = Q / area stays consistent everywhere in the field.
  const qTotal = uOut * Math.PI * GEO.pipeRadius * GEO.pipeRadius;

  const phiA = momentumFlux(qA);
  const phiB = momentumFlux(qB);
  const phiSum = phiA + phiB;

  // --- Momentum balance at the ports ---------------------------------
  // Axial momentum flux.
  const mx = phiA * PORT_A.direction.x + phiB * PORT_B.direction.x;
  // Transverse momentum flux. Zero when the branches are balanced, because
  // the ports are point-symmetric; any imbalance leaves a net sideways push.
  const py = phiA * PORT_A.direction.y + phiB * PORT_B.direction.y;
  const pz = phiA * PORT_A.direction.z + phiB * PORT_B.direction.z;
  // Angular momentum flux about the outlet axis.
  const lx = phiA * PORT_A.specificSwirl + phiB * PORT_B.specificSwirl;

  const safeMx = Math.max(mx, 1e-9);

  // Swirl number, the standard S = L / (R * M). For fixed geometry this is
  // near-constant, which is correct: the chamber's swirl is designed in.
  const swirlNumber = phiSum > 1e-9 ? lx / (PIPE_RADIUS_M * safeMx) : 0;

  // Lateral displacement of the vortex core, driven purely by the transverse
  // momentum the branches fail to cancel. THIS is what an unbalanced junction
  // writes onto the sensor ring.
  const biasY = py / safeMx;
  const biasZ = pz / safeMx;
  const biasMag = Math.hypot(biasY, biasZ);
  const cappedMag = Math.min(biasMag * CORE_OFFSET_GAIN, MAX_CORE_OFFSET);
  const scale = biasMag > 1e-9 ? (cappedMag * GEO.pipeRadius) / biasMag : 0;
  const coreOffsetY = biasY * scale;
  const coreOffsetZ = biasZ * scale;

  // The same imbalance also leans the whole axial momentum profile toward the
  // stronger branch, and that lean survives all the way to the sensor ring.
  // It is the larger of the two effects by some margin: the displaced core
  // moves a narrow deficit around, while the lean tilts the entire bore.
  const leanMag = Math.min(biasMag * LEAN_GAIN, MAX_LEAN);
  const leanScale = biasMag > 1e-9 ? leanMag / biasMag : 0;
  const leanY = biasY * leanScale;
  const leanZ = biasZ * leanScale;

  // Shear between the two streams: the mixing layer's energy source.
  const shear = uOut_ms > 1e-6 ? Math.abs(uA_ms - uB_ms) / uOut_ms : 0;

  // Vortex breakdown. Real swirling pipe flow develops an axial velocity
  // deficit on the core once the swirl number passes ~0.3, and an adverse
  // pressure gradient downstream brings it on sooner. Above 1 the deficit
  // exceeds the through-flow and a recirculation bubble opens.
  const axialDeficit = clamp(
    BREAKDOWN_GAIN * (swirlNumber - BREAKDOWN_ONSET) +
      RESTRICTION_GAIN * cond.downstreamRestriction +
      SHEAR_GAIN * shear,
    0,
    1.75,
  );

  // Lamb-Oseen core radius: tightens with swirl, swells once breakdown starts.
  // The swelling is kept modest on purpose. A bubble that grows to occupy most
  // of the bore would need the surrounding annulus to carry the whole flow
  // through a sliver of area, which both looks wrong and suppresses the
  // reversal the swelling is supposed to accompany.
  const coreRadius =
    GEO.pipeRadius *
    (0.46 - 0.18 * clamp(swirlNumber, 0, 1) + 0.12 * smoothstep(0.7, 1.4, axialDeficit));

  // Circulation from the peak tangential velocity a Lamb-Oseen vortex
  // reaches at r = 1.1209 * coreRadius, where v_theta = 0.7151 * G / (2 pi rc).
  const vThetaPeak = SWIRL_TO_TANGENTIAL * swirlNumber * uOut;
  const circulation = (vThetaPeak * 2 * Math.PI * coreRadius) / 0.7151;

  // Precessing vortex core. Off-axis and broken-down cores wander; a centred,
  // stable one barely moves.
  const precessAmp =
    GEO.pipeRadius * (0.035 + 0.55 * cappedMag + 0.22 * smoothstep(0.6, 1.5, axialDeficit));
  const precessOmega =
    0.9 * swirlNumber * (uOut / Math.max(GEO.pipeRadius, 1e-6)) * (0.6 + 0.6 * smoothstep(0.4, 1.4, axialDeficit));
  const precessK = 0.55; // helix pitch along x

  const turbIntensity =
    0.14 +
    0.62 * shear +
    0.55 * cond.downstreamRestriction +
    0.30 * smoothstep(0.35, 1.3, axialDeficit) +
    0.25 * cond.noiseLevel;

  return {
    uA,
    uB,
    uOut,
    qTotal,
    swirlNumber,
    circulation,
    coreRadius,
    coreOffsetY,
    coreOffsetZ,
    leanY,
    leanZ,
    precessAmp,
    precessOmega,
    precessK,
    axialDeficit,
    shear,
    turbIntensity,
    time: displayTime,
  };
}

/** Convenience for UI: bulk outlet velocity in real m/s. */
export function outletVelocityMs(cond: JunctionCondition): number {
  return (
    (Math.max(cond.inletA.flowLps, 0) + Math.max(cond.inletB.flowLps, 0)) /
    1000 /
    PIPE_AREA_M2
  );
}

/** Convenience for UI: pipe Reynolds number at the outlet (20 C water). */
export function outletReynolds(cond: JunctionCondition): number {
  const nu = 1.004e-6; // m^2/s
  return (outletVelocityMs(cond) * 2 * PIPE_RADIUS_M) / nu;
}
