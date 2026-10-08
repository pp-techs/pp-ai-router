import { describe, expect, it } from "vite-plus/test";
import { createSelector, type Candidate } from "../src/pool/selectors.ts";

const cand = (id: string, over: Partial<Candidate> = {}): Candidate => ({
  id,
  weight: 1,
  priority: 0,
  inflight: 0,
  recentTokens: 0,
  lastUsedAt: 0,
  ...over,
});

const picks = (selector: ReturnType<typeof createSelector>, list: Candidate[], n: number) =>
  Array.from({ length: n }, () => selector.pick(list).id);

describe("round_robin", () => {
  it("cycles through candidates in stable order", () => {
    const s = createSelector("round_robin");
    expect(picks(s, [cand("b"), cand("a"), cand("c")], 6)).toEqual(["a", "b", "c", "a", "b", "c"]);
  });

  it("continues after the last pick when a candidate drops out and returns", () => {
    const s = createSelector("round_robin");
    expect(picks(s, [cand("a"), cand("b"), cand("c")], 2)).toEqual(["a", "b"]);
    expect(picks(s, [cand("a"), cand("c")], 2)).toEqual(["c", "a"]); // b is cooling down
    expect(picks(s, [cand("a"), cand("b"), cand("c")], 1)).toEqual(["b"]);
  });
});

describe("weighted", () => {
  it("distributes picks in proportion to weight and interleaves them", () => {
    const s = createSelector("weighted");
    const list = [cand("a", { weight: 5 }), cand("b", { weight: 1 }), cand("c", { weight: 1 })];
    const result = picks(s, list, 7);
    expect(result.filter((x) => x === "a")).toHaveLength(5);
    expect(result.filter((x) => x === "b")).toHaveLength(1);
    expect(result.filter((x) => x === "c")).toHaveLength(1);
    expect(result.slice(0, 3)).not.toEqual(["a", "a", "a"]); // smooth: not bursty
  });

  it("keeps proportions after a candidate leaves and rejoins", () => {
    const s = createSelector("weighted");
    const full = [cand("a", { weight: 3 }), cand("b", { weight: 1 })];
    picks(s, full, 4);
    picks(s, [cand("b", { weight: 1 })], 3);
    const result = picks(s, full, 8);
    expect(result.filter((x) => x === "a")).toHaveLength(6);
  });
});

describe("least_inflight", () => {
  it("prefers the least busy credential, breaking ties by least recently used", () => {
    const s = createSelector("least_inflight");
    expect(
      s.pick([cand("a", { inflight: 2 }), cand("b", { inflight: 1 }), cand("c", { inflight: 3 })])
        .id,
    ).toBe("b");
    expect(s.pick([cand("a", { lastUsedAt: 50 }), cand("b", { lastUsedAt: 10 })]).id).toBe("b");
  });
});

describe("least_used", () => {
  it("prefers the credential with the fewest recent tokens relative to its weight", () => {
    const s = createSelector("least_used");
    const list = [
      cand("a", { recentTokens: 900, weight: 3 }),
      cand("b", { recentTokens: 500, weight: 1 }),
    ];
    expect(s.pick(list).id).toBe("a"); // 300 per weight unit vs 500
  });
});

describe("fill_first", () => {
  it("always uses the lowest priority number until it is unavailable", () => {
    const s = createSelector("fill_first");
    const list = [
      cand("a", { priority: 2 }),
      cand("b", { priority: 1 }),
      cand("c", { priority: 1 }),
    ];
    expect(picks(s, list, 3)).toEqual(["b", "b", "b"]);
    expect(s.pick(list.filter((c) => c.id !== "b" && c.id !== "c")).id).toBe("a");
  });
});

describe("random", () => {
  it("indexes candidates with the injected rng", () => {
    const list = [cand("a"), cand("b"), cand("c")];
    expect(createSelector("random", () => 0).pick(list).id).toBe("a");
    expect(createSelector("random", () => 0.99).pick(list).id).toBe("c");
  });
});
