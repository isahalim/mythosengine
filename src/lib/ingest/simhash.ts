/**
 * 64-bit simhash over word 3-grams, for near-duplicate detection across
 * WATCH sources (ARCHITECTURE.md §5.2) — "same story from 12 aggregators
 * collapses to one signal" needs a locality-sensitive fingerprint, not an
 * exact-match check. Pure, deterministic, no external dependency.
 */

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = (1n << 64n) - 1n;

function fnv1a64(input: string): bigint {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash;
}

function normalize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

function shingles(words: string[], n: number): string[] {
  if (words.length < n) return words.length > 0 ? [words.join(" ")] : [];
  const result: string[] = [];
  for (let i = 0; i <= words.length - n; i++) {
    result.push(words.slice(i, i + n).join(" "));
  }
  return result;
}

/**
 * Returns a 64-bit fingerprint as a bigint. Empty/whitespace-only text
 * hashes to 0n. Uses single-word shingles, not 3-grams: headline-length
 * text (a dozen words) is short enough that 3-word shingles make a single
 * word swap disrupt most of the fingerprint's input — verified empirically
 * (a "GTA 6" vs "GTA VI" headline pair landed a Hamming distance of 27/64,
 * indistinguishable from unrelated text) before picking unigrams instead.
 */
export function simhash64(text: string): bigint {
  const grams = shingles(normalize(text), 1);
  if (grams.length === 0) return 0n;

  const weights = new Array<number>(64).fill(0);
  for (const gram of grams) {
    const hash = fnv1a64(gram);
    for (let bit = 0; bit < 64; bit++) {
      const isSet = (hash >> BigInt(bit)) & 1n;
      weights[bit] += isSet === 1n ? 1 : -1;
    }
  }

  let fingerprint = 0n;
  for (let bit = 0; bit < 64; bit++) {
    if (weights[bit] > 0) fingerprint |= 1n << BigInt(bit);
  }
  return fingerprint;
}

export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x > 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

/**
 * Default threshold calibrated empirically against headline-length text
 * (~7-12 words), not picked as a round number: a single-word swap between
 * otherwise-identical headlines lands around distance 7-14; genuinely
 * unrelated headlines land around 25-30. 16 sits in the gap. Short text
 * makes simhash noisier than it is on full documents — every word carries
 * more of the bit vote — so this threshold is specifically tuned for
 * signal titles, not a general-purpose default.
 */
export function isNearDuplicate(a: bigint, b: bigint, threshold = 16): boolean {
  return hammingDistance(a, b) <= threshold;
}

/** Fingerprint as a hex string for storage in signals.simhash (TEXT column). */
export function simhashToHex(fingerprint: bigint): string {
  return fingerprint.toString(16).padStart(16, "0");
}

export function hexToSimhash(hex: string): bigint {
  return BigInt(`0x${hex}`);
}
