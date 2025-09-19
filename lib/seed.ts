/**
 * Deterministic PRNG and helpers for reproducible generation.
 *
 * Uses mulberry32 (simple, fast, and repeatable) seeded RNG.
 *
 * Exported helpers:
 * - createRng(seed): returns a rng() function that yields floats in [0,1)
 * - pick(rng, arr): pick deterministic element from array
 * - chance(rng, p): returns boolean with probability p
 * - intBetween(rng, a, b): inclusive integer between a and b
 * - idFromSeed(prefix, seed, idx): deterministic id string
 */

export function createRng(seed: number) {
  // mulberry32
  let t = seed >>> 0;
  return function rng() {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: () => number, arr: T[]) {
  if (!arr || arr.length === 0) return undefined;
  const idx = Math.floor(rng() * arr.length);
  return arr[idx];
}

export function chance(rng: () => number, p: number) {
  return rng() < p;
}

export function intBetween(rng: () => number, min: number, max: number) {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  return Math.floor(rng() * (hi - lo + 1)) + lo;
}

export function idFromSeed(prefix: string, seed: number, idx: number) {
  // Simple deterministic id using seed and index
  const base = ((seed * 9973) ^ (idx * 10007)) >>> 0;
  return `${prefix}_${base.toString(36)}`;
}
