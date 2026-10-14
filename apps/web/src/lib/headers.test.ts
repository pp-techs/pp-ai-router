import { describe, expect, it } from "vite-plus/test";
import { emptyHeaderRow, headerMap, headerRows } from "./headers.ts";

describe("headerMap", () => {
  it("trims names and values and drops blank rows", () => {
    expect(
      headerMap([
        { name: " x-gateway ", value: " prod " },
        emptyHeaderRow(),
        { name: "", value: "orphan" },
      ]),
    ).toEqual({ "x-gateway": "prod" });
  });

  it("keeps the last row of a repeated name", () => {
    expect(
      headerMap([
        { name: "x-title", value: "first" },
        { name: "x-title", value: "second" },
      ]),
    ).toEqual({ "x-title": "second" });
  });

  it("round-trips a stored map", () => {
    const stored = { "x-gateway": "prod", "x-title": "router" };
    expect(headerMap(headerRows(stored))).toEqual(stored);
    expect(headerRows({})).toEqual([]);
  });
});
