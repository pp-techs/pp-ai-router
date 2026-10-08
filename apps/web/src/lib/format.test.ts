import { describe, expect, it } from "vite-plus/test";
import {
  formatDuration,
  formatInt,
  formatLatency,
  formatMetric,
  formatTier,
  formatUsd,
} from "./format.ts";

describe("formatUsd", () => {
  it("shows cents for ordinary amounts", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(5)).toBe("$5.00");
    expect(formatUsd(1234.5)).toBe("$1,234.50");
    expect(formatUsd(0.5)).toBe("$0.50");
  });

  it("adds decimals until three significant digits show for small amounts", () => {
    expect(formatUsd(0.0123456)).toBe("$0.0123");
    expect(formatUsd(0.000042)).toBe("$0.000042");
    expect(formatUsd(0.00000123)).toBe("$0.00000123");
  });

  it("does not print a misleading zero for dust", () => {
    expect(formatUsd(1e-10)).toBe("<$0.00000001");
  });
});

describe("other formatters", () => {
  it("groups digits", () => {
    expect(formatInt(1234567)).toBe("1,234,567");
    expect(formatMetric("total_tokens", 200000)).toBe("200,000");
    expect(formatMetric("usd", 2)).toBe("$2.00");
  });

  it("formats latency", () => {
    expect(formatLatency(87)).toBe("87 ms");
    expect(formatLatency(2345)).toBe("2.35 s");
  });

  it("keeps the two largest duration units", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(3 * 3600_000 + 12 * 60_000 + 5000)).toBe("3h 12m");
    expect(formatDuration(2 * 86_400_000 + 3600_000)).toBe("2d 1h");
    expect(formatDuration(-5)).toBe("0s");
  });
});

describe("formatTier", () => {
  it("converts per-token tier prices to per-1M and skips absent ones", () => {
    expect(formatTier({ aboveTokens: 200_000, input: 0.000006, output: 0.0000225 })).toBe(
      "> 200K tokens: in $6.00 · out $22.50",
    );
    expect(formatTier({ aboveTokens: 128_000, cacheRead: 1e-7 })).toBe(
      "> 128K tokens: cache read $0.10",
    );
  });
});
