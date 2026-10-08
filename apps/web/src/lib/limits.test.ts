import { describe, expect, it } from "vite-plus/test";
import { emptyLimitDraft, usedFraction, validateLimit, windowError } from "./limits.ts";

describe("windowError", () => {
  it("accepts what the server accepts", () => {
    for (const w of ["total", "30m", "1h", "1d", "7d", "2w", "36h"])
      expect(windowError(w)).toBeNull();
  });

  it("rejects malformed and out-of-range windows", () => {
    expect(windowError("")).toMatch(/Invalid window/);
    expect(windowError("1 day")).toMatch(/Invalid window/);
    expect(windowError("-5m")).toMatch(/Invalid window/);
    expect(windowError("0m")).toMatch(/at least 1 minute/);
    expect(windowError("1441m")).toMatch(/whole hours/);
  });
});

describe("validateLimit", () => {
  const draft = { ...emptyLimitDraft(), max: "5" };

  it("builds the request body from a valid draft", () => {
    expect(validateLimit({ ...draft, window: " 1h ", mode: "rolling", max: "2.5" })).toEqual({
      ok: true,
      limit: { metric: "usd", window: "1h", mode: "rolling", max: 2.5 },
    });
  });

  it("requires a number for max", () => {
    for (const max of ["", "  ", "abc", "-1"]) {
      expect(validateLimit({ ...draft, max }).ok).toBe(false);
    }
  });

  it("only allows fractional maximums for usd", () => {
    expect(validateLimit({ ...draft, metric: "requests", max: "1.5" }).ok).toBe(false);
    expect(validateLimit({ ...draft, metric: "total_tokens", max: "1000" }).ok).toBe(true);
  });

  it("surfaces the window problem", () => {
    expect(validateLimit({ ...draft, window: "soon" })).toMatchObject({ ok: false });
  });
});

describe("usedFraction", () => {
  it("clamps to [0, 1]", () => {
    expect(usedFraction(2.5, 10)).toBe(0.25);
    expect(usedFraction(15, 10)).toBe(1);
    expect(usedFraction(0, 0)).toBe(1);
  });
});
