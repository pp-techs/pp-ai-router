import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { ADMIN_TOKEN, createHarness, readJson } from "./harness.ts";

const dist = mkdtempSync(join(tmpdir(), "web-dist-"));
mkdirSync(join(dist, "assets"));
writeFileSync(join(dist, "index.html"), "<!doctype html><title>router ui</title>");
writeFileSync(join(dist, "assets", "app.js"), "console.log('ui')");
afterAll(() => rmSync(dist, { recursive: true, force: true }));

describe("admin UI hosting", () => {
  const { services } = createHarness({ WEB_DIST: dist });
  const get = (path: string, headers: Record<string, string> = {}) =>
    services.app.request(path, { headers });

  it("serves the built files and falls back to index.html for client-side routes", async () => {
    expect(await (await get("/")).text()).toContain("router ui");
    const asset = await get("/assets/app.js");
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(await asset.text()).toBe("console.log('ui')");
    for (const route of ["/providers", "/keys/abc", "/usage"]) {
      const res = await get(route);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("router ui");
    }
  });

  it("never lets the SPA fallback shadow the API", async () => {
    const unknownV1 = await get("/v1/nope");
    expect(unknownV1.status).toBe(404);
    expect((await readJson(unknownV1)).error.code).toBe("not_found");
    expect((await get("/admin/keys")).status).toBe(401);
    expect((await get("/admin/keys", { authorization: `Bearer ${ADMIN_TOKEN}` })).status).toBe(200);
    expect((await readJson(await get("/healthz"))).ok).toBe(true);
  });

  it("stays API-only when the directory has no index.html", async () => {
    const empty = mkdtempSync(join(tmpdir(), "web-empty-"));
    try {
      const h = createHarness({ WEB_DIST: empty });
      expect((await h.services.app.request("/")).status).toBe(404);
      expect((await h.services.app.request("/healthz")).status).toBe(200);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
