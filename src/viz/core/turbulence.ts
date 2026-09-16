import { fastSin, makeRng, type Vec3 } from './math';

/**
 * Solenoidal turbulence by truncated Fourier synthesis.
 *
 * Each mode is A_i * sin(k_i . x + w_i t) with A_i perpendicular to k_i.
 * A single Fourier mode of that form is divergence-free by construction, so
 * the sum is too: tracer particles advected by it neither pile up nor thin
 * out, which is what keeps the fluid looking like fluid rather than like
 * drifting dust. Amplitudes follow a -5/3 rolloff so the large eddies carry
 * the energy, as in a real inertial range.
 *
 * Six modes is enough to read as turbulence and cheap enough to evaluate a
 * few million times a second on the CPU.
 */

const MODE_COUNT = 6;

interface Mode {
  kx: number; ky: number; kz: number;
  ax: number; ay: number; az: number;
  w: number;
}

function buildModes(): Mode[] {
  const rng = makeRng(0x5eed1e);
  const modes: Mode[] = [];

  // Wavelengths from roughly the chamber diameter down to a fraction of the
  // pipe radius, in world units.
  const wavelengths = [3.4, 2.1, 1.35, 0.85, 0.55, 0.34];

  for (let i = 0; i < MODE_COUNT; i++) {
    // Random direction on the sphere for the wave vector.
    const u = rng() * 2 - 1;
    const phi = rng() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const dx = s * Math.cos(phi);
    const dy = s * Math.sin(phi);
    const dz = u;

    const k = (Math.PI * 2) / wavelengths[i];

    // Amplitude vector: any vector perpendicular to k. Build one by crossing
    // k with an arbitrary non-parallel axis.
    const refx = Math.abs(dx) < 0.9 ? 1 : 0;
    const refy = Math.abs(dx) < 0.9 ? 0 : 1;
    let px = dy * 0 - dz * refy;
    let py = dz * refx - dx * 0;
    let pz = dx * refy - dy * refx;
    const pl = Math.hypot(px, py, pz) || 1;

    // Rotate the perpendicular vector by a random angle inside the plane so
    // successive modes do not share an orientation bias.
    const qx = dy * pz - dz * py;
    const qy = dz * px - dx * pz;
    const qz = dx * py - dy * px;
    const ang = rng() * Math.PI * 2;
    const ca = Math.cos(ang) / pl;
    const sa = Math.sin(ang) / pl;
    px = px * ca + qx * sa;
    py = py * ca + qy * sa;
    pz = pz * ca + qz * sa;

    // Kolmogorov-like rolloff: amplitude ~ k^(-5/6) so energy ~ k^(-5/3).
    const amp = Math.pow(wavelengths[i] / wavelengths[0], 5 / 6);

    modes.push({
      kx: dx * k, ky: dy * k, kz: dz * k,
      ax: px * amp, ay: py * amp, az: pz * amp,
      // Eddy turnover frequency grows with wavenumber.
      w: 0.55 + 1.9 * (wavelengths[0] / wavelengths[i]) * rng(),
    });
  }
  return modes;
}

const MODES = buildModes();

/** Accumulates the turbulent perturbation at p into `out` (adds, does not set). */
export function addTurbulence(
  out: Vec3,
  px: number,
  py: number,
  pz: number,
  t: number,
  amplitude: number,
): void {
  if (amplitude <= 0) return;
  let vx = 0;
  let vy = 0;
  let vz = 0;
  for (let i = 0; i < MODE_COUNT; i++) {
    const m = MODES[i];
    const s = fastSin(m.kx * px + m.ky * py + m.kz * pz + m.w * t);
    vx += m.ax * s;
    vy += m.ay * s;
    vz += m.az * s;
  }
  out.x += vx * amplitude;
  out.y += vy * amplitude;
  out.z += vz * amplitude;
}
