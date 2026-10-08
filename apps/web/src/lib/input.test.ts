import { describe, expect, it } from "vite-plus/test";
import {
  formatList,
  fromDatetimeLocal,
  optionalNumber,
  parseList,
  toDatetimeLocal,
} from "./input.ts";

describe("parseList", () => {
  it("splits on commas and whitespace", () => {
    expect(parseList("gpt-*, claude-*\n  o1")).toEqual(["gpt-*", "claude-*", "o1"]);
  });

  it("maps blank input to null (no restriction)", () => {
    expect(parseList("")).toBeNull();
    expect(parseList(" , \n")).toBeNull();
    expect(formatList(null)).toBe("");
    expect(formatList(["a", "b"])).toBe("a, b");
  });
});

describe("numeric and date fields", () => {
  it("treats blank as null", () => {
    expect(optionalNumber(" ")).toBeNull();
    expect(optionalNumber("60")).toBe(60);
  });

  it("round-trips datetime-local values", () => {
    const ms = fromDatetimeLocal("2026-10-08T09:30");
    expect(ms).not.toBeNull();
    expect(toDatetimeLocal(ms)).toBe("2026-10-08T09:30");
    expect(fromDatetimeLocal("")).toBeNull();
    expect(toDatetimeLocal(null)).toBe("");
  });
});
