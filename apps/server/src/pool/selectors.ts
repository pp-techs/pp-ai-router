export const STRATEGIES = [
  "round_robin",
  "weighted",
  "least_inflight",
  "least_used",
  "fill_first",
  "random",
] as const;
export type Strategy = (typeof STRATEGIES)[number];

/** Runtime view of one eligible credential, built fresh for every pick. */
export interface Candidate {
  id: string;
  /** Relative share for `weighted`; >= 1. */
  weight: number;
  /** Lower is tried first by `fill_first`. */
  priority: number;
  inflight: number;
  /** Tokens consumed over the recent window; drives `least_used`. */
  recentTokens: number;
  lastUsedAt: number;
}

/** Stateful per provider; `candidates` is never empty and may differ between calls. */
export interface KeySelector {
  pick(candidates: readonly Candidate[]): Candidate;
}

function minBy(candidates: readonly Candidate[], ...keys: ((c: Candidate) => number)[]): Candidate {
  let best = candidates[0]!;
  for (const c of candidates) {
    for (const key of keys) {
      const a = key(c);
      const b = key(best);
      if (a < b) {
        best = c;
        break;
      }
      if (a > b) break;
    }
  }
  return best;
}

/** Next candidate after the previously picked one, in stable id order; survives candidates appearing and vanishing. */
function roundRobin(): KeySelector {
  let last: string | null = null;
  return {
    pick(candidates) {
      const ordered = [...candidates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const next = (last === null ? undefined : ordered.find((c) => c.id > last!)) ?? ordered[0]!;
      last = next.id;
      return next;
    },
  };
}

/** Smooth weighted round-robin (the nginx algorithm): interleaves picks in proportion to weight. */
function weighted(): KeySelector {
  const current = new Map<string, number>();
  return {
    pick(candidates) {
      const live = new Set(candidates.map((c) => c.id));
      for (const id of current.keys()) if (!live.has(id)) current.delete(id);

      let total = 0;
      let best: Candidate | null = null;
      let bestScore = -Infinity;
      for (const c of candidates) {
        const weight = Math.max(1, c.weight);
        total += weight;
        const score = (current.get(c.id) ?? 0) + weight;
        current.set(c.id, score);
        if (score > bestScore) {
          best = c;
          bestScore = score;
        }
      }
      current.set(best!.id, bestScore - total);
      return best!;
    },
  };
}

export function createSelector(strategy: Strategy, rng: () => number = Math.random): KeySelector {
  switch (strategy) {
    case "round_robin":
      return roundRobin();
    case "weighted":
      return weighted();
    case "least_inflight":
      return {
        pick: (c) =>
          minBy(
            c,
            (x) => x.inflight,
            (x) => x.lastUsedAt,
            (x) => -x.weight,
          ),
      };
    case "least_used":
      return {
        pick: (c) =>
          minBy(
            c,
            (x) => x.recentTokens / Math.max(1, x.weight),
            (x) => x.inflight,
            (x) => x.lastUsedAt,
          ),
      };
    case "fill_first":
      return { pick: (c) => minBy(c, (x) => x.priority) };
    case "random":
      return { pick: (c) => c[Math.floor(rng() * c.length)]! };
  }
}
