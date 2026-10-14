import { describe, expect, it } from "vite-plus/test";
import type { Credential } from "../api/types.ts";
import { draftFromCredential, draftToBody, emptyCredentialDraft } from "./credential-draft.ts";

const credential = (patch: Partial<Credential> = {}): Credential => ({
  id: "c",
  provider_id: "p",
  label: "main",
  kind: "api_key",
  secret_hint: "…abcd",
  account: null,
  expires_at: null,
  weight: 2,
  priority: -1,
  models: ["gpt-*"],
  rpm_limit: 60,
  enabled: false,
  status: "active",
  last_error: null,
  inflight: 0,
  fail_count: 0,
  cooldown_until: null,
  headers: { "x-gateway": "prod" },
  ...patch,
});

describe("credential draft", () => {
  it("edits a credential's header overrides and sends them back as a map", () => {
    const draft = draftFromCredential(credential());
    expect(draft.headers).toEqual([{ name: "x-gateway", value: "prod" }]);
    expect(
      draftToBody({ ...draft, headers: [...draft.headers, { name: " ", value: "junk" }] }),
    ).toMatchObject({ headers: { "x-gateway": "prod" } });
  });

  it("starts a new credential without headers", () => {
    expect(draftToBody(emptyCredentialDraft())).toMatchObject({
      weight: 1,
      priority: 0,
      rpm_limit: null,
      models: null,
      headers: {},
    });
  });
});
