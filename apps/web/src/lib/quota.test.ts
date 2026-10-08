import { describe, expect, it } from "vite-plus/test";
import type { QuotaFailure } from "../api/types.ts";
import { describeFailure, formatCredits, quotaFraction } from "./quota.ts";

describe("describeFailure", () => {
  it("has text for every failure code", () => {
    const codes: QuotaFailure[] = [
      "account_unavailable",
      "access_denied",
      "rate_limited",
      "upstream_error",
      "timeout",
      "transport_error",
      "response_unusable",
    ];
    const texts = codes.map((c) => describeFailure(c));
    for (const text of texts) expect(text.length).toBeGreaterThan(0);
    expect(new Set(texts).size).toBe(codes.length);
  });
});

describe("formatCredits", () => {
  it("trims trailing zeros and caps at two decimals", () => {
    expect(formatCredits({ used: 12.5, limit: 50 })).toBe("12.5 / 50 credits");
    expect(formatCredits({ used: 0, limit: 1000 })).toBe("0 / 1,000 credits");
    expect(formatCredits({ used: 1.206, limit: 3.14159 })).toBe("1.21 / 3.14 credits");
  });
});

describe("quotaFraction", () => {
  it("clamps to 0..1", () => {
    expect(quotaFraction(42.5)).toBe(0.425);
    expect(quotaFraction(150)).toBe(1);
    expect(quotaFraction(-5)).toBe(0);
    expect(quotaFraction(Number.NaN)).toBe(0);
  });
});
