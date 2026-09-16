/** Small allocation-free vector helpers used by the hot particle loop. */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function length3(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

export function normalizeInto(out: Vec3, x: number, y: number, z: number): Vec3 {
  const l = Math.sqrt(x * x + y * y + z * z) || 1;
  out.x = x / l;
  out.y = y / l;
  out.z = z / l;
  return out;
}

/** Deterministic hash -> [0,1). Keeps scenarios reproducible across reloads. */
export function hash01(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Mulberry32 — tiny seeded PRNG for repeatable particle seeding and noise. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* Fast sine
/* ------------------------------------------------------------------ */

const SIN_BITS = 12;
const SIN_SIZE = 1 << SIN_BITS; // 4096
const SIN_MASK = SIN_SIZE - 1;
const SIN_TABLE = new Float32Array(SIN_SIZE + 1);
for (let i = 0; i <= SIN_SIZE; i++) {
  SIN_TABLE[i] = Math.sin((i / SIN_SIZE) * Math.PI * 2);
}
const TABLE_SCALE = SIN_SIZE / (Math.PI * 2);

/**
 * Table-interpolated sine. The turbulence synthesis needs several million
 * sine evaluations per second; this is ~4x faster than Math.sin and the
 * residual error (<1e-4) is far below the noise amplitude it modulates.
 */
export function fastSin(x: number): number {
  const f = x * TABLE_SCALE;
  const i = Math.floor(f);
  const frac = f - i;
  const i0 = i & SIN_MASK;
  const a = SIN_TABLE[i0];
  return a + (SIN_TABLE[i0 + 1] - a) * frac;
}
