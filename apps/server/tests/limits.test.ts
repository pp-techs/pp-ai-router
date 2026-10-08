import { describe, expect, it } from "vite-plus/test";
import { openDatabase } from "../src/db/database.ts";
import { formatWindow, parseWindow, UsageMeter, type Limit } from "../src/governance/limits.ts";
import { VirtualKeyStore } from "../src/governance/virtual-keys.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function setup() {
  const db = openDatabase(":memory:");
  const keys = new VirtualKeyStore(db);
  const { key } = keys.create({ name: "k" }, 0);
  return { db, meter: new UsageMeter(db), key };
}

const limit = (keyId: string, over: Partial<Limit>): Limit => ({
  id: "l",
  keyId,
  metric: "usd",
  windowSec: 3600,
  mode: "fixed",
  max: 1,
  ...over,
});

const spend = (usd: number, tokens = 0) => ({
  requests: 1,
  inputTokens: tokens,
  outputTokens: 0,
  costUsd: usd,
});

describe("parseWindow", () => {
  it("parses units and total, and rejects garbage", () => {
    expect(parseWindow("30m")).toBe(1800);
    expect(parseWindow("1h")).toBe(3600);
    expect(parseWindow("7d")).toBe(604_800);
    expect(parseWindow("total")).toBeNull();
    expect(formatWindow(86_400)).toBe("1d");
    expect(() => parseWindow("90s")).toThrow();
    expect(() => parseWindow("0m")).toThrow();
    expect(() => parseWindow("90m")).not.toThrow();
    expect(() => parseWindow("1501m")).toThrow(); // >1 day must be whole hours
  });
});

describe("UsageMeter", () => {
  it("fixed hourly window resets at the next hour boundary", () => {
    const { meter, key } = setup();
    const l = limit(key.id, { windowSec: 3600, mode: "fixed", max: 1 });
    const t0 = 10 * HOUR + 5 * 60_000;
    meter.record(key.id, spend(0.6), t0);
    meter.record(key.id, spend(0.5), t0 + 60_000);

    const blocked = meter.firstExceeded([l], t0 + 2 * 60_000);
    expect(blocked?.used).toBeCloseTo(1.1);
    expect(blocked?.resetsAt).toBe(11 * HOUR);
    expect(meter.firstExceeded([l], 11 * HOUR)).toBeNull();
  });

  it("rolling window ages usage out gradually instead of resetting at once", () => {
    const { meter, key } = setup();
    const l = limit(key.id, { windowSec: 3600, mode: "rolling", max: 1 });
    const t0 = 10 * HOUR;
    meter.record(key.id, spend(0.7), t0);
    meter.record(key.id, spend(0.7), t0 + 30 * 60_000);

    expect(meter.firstExceeded([l], t0 + 31 * 60_000)).not.toBeNull();
    // First spend has aged out (one-minute bucket granularity), second still counts.
    const later = meter.status(l, t0 + 62 * 60_000);
    expect(later.used).toBeCloseTo(0.7);
    expect(later.resetsAt).toBeNull();
    expect(meter.firstExceeded([l], t0 + 62 * 60_000)).toBeNull();
  });

  it("supports every metric and a lifetime total", () => {
    const { meter, key } = setup();
    meter.record(key.id, { requests: 1, inputTokens: 100, outputTokens: 50, costUsd: 0.01 }, 0);
    meter.record(
      key.id,
      { requests: 1, inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
      40 * DAY,
    );
    const at = 40 * DAY + 1000;
    const used = (metric: Limit["metric"]) =>
      meter.status(limit(key.id, { metric, windowSec: null }), at).used;
    expect(used("requests")).toBe(2);
    expect(used("input_tokens")).toBe(110);
    expect(used("output_tokens")).toBe(55);
    expect(used("total_tokens")).toBe(165);
    expect(used("usd")).toBeCloseTo(0.02);
    // A 1-day window only sees the recent request.
    expect(
      meter.status(
        limit(key.id, { metric: "total_tokens", windowSec: 86_400, mode: "rolling" }),
        at,
      ).used,
    ).toBe(15);
  });

  it("isolates keys from each other", () => {
    const { db, meter, key } = setup();
    const other = new VirtualKeyStore(db).create({ name: "o" }, 0).key;
    meter.record(other.id, spend(5), 1000);
    expect(meter.status(limit(key.id, { windowSec: null }), 2000).used).toBe(0);
  });
});
