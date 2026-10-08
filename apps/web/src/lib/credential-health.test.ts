import { describe, expect, it } from "vite-plus/test";
import type { Credential } from "../api/types.ts";
import { credentialHealth, summarizeHealth } from "./credential-health.ts";

const NOW = 1_000_000;
const cred = (patch: Partial<Credential> = {}): Credential => ({
  id: "c",
  provider_id: "p",
  label: "main",
  kind: "api_key",
  secret_hint: "…abcd",
  account: null,
  expires_at: null,
  weight: 1,
  priority: 0,
  models: null,
  rpm_limit: null,
  enabled: true,
  status: "active",
  last_error: null,
  inflight: 0,
  fail_count: 0,
  cooldown_until: null,
  ...patch,
});

describe("credentialHealth", () => {
  it("ranks dead above disabled above cooling", () => {
    expect(credentialHealth(cred(), NOW)).toBe("ready");
    expect(credentialHealth(cred({ cooldown_until: NOW + 5000 }), NOW)).toBe("cooling");
    expect(credentialHealth(cred({ cooldown_until: NOW - 1 }), NOW)).toBe("ready");
    expect(credentialHealth(cred({ enabled: false, cooldown_until: NOW + 5000 }), NOW)).toBe(
      "disabled",
    );
    expect(credentialHealth(cred({ status: "dead", enabled: false }), NOW)).toBe("dead");
  });
});

describe("summarizeHealth", () => {
  it("classifies a provider by how many credentials can serve", () => {
    expect(summarizeHealth(true, [], NOW).state).toBe("no credentials");
    expect(summarizeHealth(false, [cred()], NOW).state).toBe("disabled");
    expect(summarizeHealth(true, [cred(), cred()], NOW).state).toBe("healthy");
    expect(summarizeHealth(true, [cred(), cred({ status: "dead" })], NOW).state).toBe("degraded");
    expect(summarizeHealth(true, [cred({ cooldown_until: NOW + 1 })], NOW).state).toBe("degraded");
    expect(
      summarizeHealth(true, [cred({ status: "dead" }), cred({ enabled: false })], NOW).state,
    ).toBe("unavailable");
  });

  it("counts every credential once", () => {
    const { counts } = summarizeHealth(
      true,
      [
        cred(),
        cred({ status: "dead" }),
        cred({ enabled: false }),
        cred({ cooldown_until: NOW + 1 }),
      ],
      NOW,
    );
    expect(counts).toEqual({ ready: 1, cooling: 1, dead: 1, disabled: 1 });
  });
});
