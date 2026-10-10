import { afterEach, describe, expect, it } from "vite-plus/test";
import { completion, createHarness, readJson, startUpstream } from "./harness.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe("audit logs", () => {
  it("records admin operations (provider create/update/delete, key create/update/delete)", async () => {
    const h = createHarness();

    // 1. Create provider
    const provRes = await h.admin("POST", "/providers", {
      id: "test-prov",
      type: "openai-compat",
      base_url: "http://127.0.0.1:9999/v1",
    });
    expect(provRes.status).toBe(201);

    // 2. Update provider
    const provPatch = await h.admin("PATCH", "/providers/test-prov", {
      max_key_attempts: 5,
    });
    expect(provPatch.status).toBe(200);

    // 3. Create virtual key
    const key = await h.newKey({ name: "audit-key" });

    // 4. Update virtual key
    const keyPatch = await h.admin("PATCH", `/keys/${key.id}`, {
      name: "audit-key-renamed",
    });
    expect(keyPatch.status).toBe(200);

    // 5. Add limit
    const limitRes = await h.admin("POST", `/keys/${key.id}/limits`, {
      metric: "requests",
      max: 100,
      window: "1h",
      mode: "fixed",
    });
    expect(limitRes.status).toBe(201);

    // 6. Delete limit
    const limitDelete = await h.admin("DELETE", `/limits/${limitRes.json.id}`);
    expect(limitDelete.status).toBe(204);

    // 7. Delete key
    const keyDelete = await h.admin("DELETE", `/keys/${key.id}`);
    expect(keyDelete.status).toBe(204);

    // 8. Delete provider
    const provDelete = await h.admin("DELETE", "/providers/test-prov");
    expect(provDelete.status).toBe(204);

    // Fetch audit logs via API
    const logsRes = await h.admin("GET", "/audit-logs");
    expect(logsRes.status).toBe(200);
    const logs = logsRes.json.data;

    expect(logs.length).toBeGreaterThanOrEqual(8);

    const actions = logs.map((l: { action: string }) => l.action);
    expect(actions).toContain("provider.create");
    expect(actions).toContain("provider.update");
    expect(actions).toContain("provider.delete");
    expect(actions).toContain("key.create");
    expect(actions).toContain("key.update");
    expect(actions).toContain("key.delete");
    expect(actions).toContain("limit.create");
    expect(actions).toContain("limit.delete");

    // Filter by action
    const provLogsRes = await h.admin("GET", "/audit-logs?action=provider.create");
    expect(provLogsRes.json.data).toHaveLength(1);
    expect(provLogsRes.json.data[0]).toMatchObject({
      category: "admin",
      action: "provider.create",
      actor: "admin",
      target_type: "provider",
      target_id: "test-prov",
      status: "success",
      status_code: 201,
    });
  });

  it("records gateway request completions in audit log with tokens and costs", async () => {
    const up = await startUpstream(() => completion({ prompt_tokens: 80, completion_tokens: 40 }));
    closers.push(up.close);

    const h = createHarness();
    await h.addProvider("p1", up.url, ["k1"]);
    await h.admin("PUT", "/pricing/overrides", {
      model: "p1/gpt",
      input_per_1m: 10,
      output_per_1m: 20,
    });
    const key = await h.newKey();

    const res = await h.chat(key.secret, { model: "p1/gpt" });
    expect(res.status).toBe(200);
    expect((await readJson(res)).choices[0].message.content).toBe("hi");

    // Audit logs should contain both the admin setups and the gateway request
    const gatewayLogs = (await h.admin("GET", "/audit-logs?category=gateway")).json.data;
    expect(gatewayLogs).toHaveLength(1);
    expect(gatewayLogs[0]).toMatchObject({
      category: "gateway",
      action: "gateway.request",
      actor: key.id,
      target_type: "model",
      target_id: "p1/gpt",
      status: "success",
      status_code: 200,
    });

    const details = JSON.parse(gatewayLogs[0].details);
    expect(details).toMatchObject({
      provider_id: "p1",
      input_tokens: 80,
      output_tokens: 40,
      status: "ok",
    });
  });

  it("redacts sensitive fields in stored details", async () => {
    const h = createHarness();
    const up = await startUpstream(() => completion());
    closers.push(up.close);

    await h.addProvider("p-sec", up.url, ["super-secret-key-123"]);

    const credLogs = (await h.admin("GET", "/audit-logs?action=credential.create")).json.data;
    expect(credLogs.length).toBeGreaterThan(0);

    for (const log of credLogs) {
      if (log.details) {
        expect(log.details).not.toContain("super-secret-key-123");
      }
    }
  });
});
