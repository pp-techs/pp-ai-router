// Adapted from can1357/oh-my-pi (MIT): the `cch` attestation of packages/ai/src/providers/anthropic.ts (XXH64, reference algorithm)
const MASK = 0xffff_ffff_ffff_ffffn;
const P1 = 0x9e3779b185ebca87n;
const P2 = 0xc2b2ae3d27d4eb4fn;
const P3 = 0x165667b19e3779f9n;
const P4 = 0x85ebca77c2b2ae63n;
const P5 = 0x27d4eb2f165667c5n;

const rotl = (x: bigint, r: bigint) => ((x << r) | (x >> (64n - r))) & MASK;
const round = (acc: bigint, input: bigint) => (rotl((acc + input * P2) & MASK, 31n) * P1) & MASK;
const mergeRound = (acc: bigint, value: bigint) => (((acc ^ round(0n, value)) * P1) & MASK) + P4;

/** XXH64 of `data`, as the 64-bit unsigned integer the reference algorithm yields. */
export function xxhash64(data: Uint8Array, seed: bigint): bigint {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const length = data.byteLength;
  let offset = 0;
  let h: bigint;

  if (length >= 32) {
    let v1 = (seed + P1 + P2) & MASK;
    let v2 = (seed + P2) & MASK;
    let v3 = seed & MASK;
    let v4 = (seed - P1) & MASK;
    for (; offset <= length - 32; offset += 32) {
      v1 = round(v1, view.getBigUint64(offset, true));
      v2 = round(v2, view.getBigUint64(offset + 8, true));
      v3 = round(v3, view.getBigUint64(offset + 16, true));
      v4 = round(v4, view.getBigUint64(offset + 24, true));
    }
    h = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & MASK;
    for (const v of [v1, v2, v3, v4]) h = mergeRound(h, v) & MASK;
  } else {
    h = (seed + P5) & MASK;
  }
  h = (h + BigInt(length)) & MASK;

  for (; offset + 8 <= length; offset += 8) {
    h = ((rotl(h ^ round(0n, view.getBigUint64(offset, true)), 27n) * P1) & MASK) + P4;
    h &= MASK;
  }
  if (offset + 4 <= length) {
    h = ((rotl(h ^ ((BigInt(view.getUint32(offset, true)) * P1) & MASK), 23n) * P2) & MASK) + P3;
    h &= MASK;
    offset += 4;
  }
  for (; offset < length; offset++) {
    h = (rotl(h ^ ((BigInt(data[offset]!) * P5) & MASK), 11n) * P1) & MASK;
  }

  h ^= h >> 33n;
  h = (h * P2) & MASK;
  h ^= h >> 29n;
  h = (h * P3) & MASK;
  h ^= h >> 32n;
  return h;
}
