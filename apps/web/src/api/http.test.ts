import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { api } from "./client.ts";
import { ApiError, auth, request } from "./http.ts";

function stubSessionStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  stubSessionStorage();
  vi.stubGlobal("location", { origin: "http://router.test" });
});
afterEach(() => vi.unstubAllGlobals());

describe("request", () => {
  it("sends the bearer token and a JSON body, dropping blank query values", async () => {
    auth.set("secret-token");
    let sentBody = "";
    const fetchMock = vi.fn(async (sent: Request) => {
      sentBody = await sent.text();
      return json({ id: "p" }, 201);
    });
    vi.stubGlobal("fetch", fetchMock);

    await request("POST", "/admin/x", { body: { a: 1 }, query: { q: "", before: 7 } });

    const [sent] = fetchMock.mock.calls[0] as [Request];
    expect(sent.url).toBe("http://router.test/admin/x?before=7");
    expect(sent.method).toBe("POST");
    expect(sent.headers.get("authorization")).toBe("Bearer secret-token");
    expect(sent.headers.get("content-type")).toContain("application/json");
    expect(sentBody).toBe('{"a":1}');
  });

  it("turns the server's error envelope into an ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          json({ error: { code: "conflict", message: 'Provider "x" already exists.' } }, 409),
        ),
    );
    await expect(request("POST", "/admin/providers")).rejects.toMatchObject({
      name: "ApiError",
      status: 409,
      code: "conflict",
      message: 'Provider "x" already exists.',
    });
  });

  it("falls back to a generic message when the body is not an error envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>bad gateway</html>", { status: 502 })),
    );
    const error = await request("GET", "/admin/providers").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 502,
      code: "http_error",
      message: "Request failed (HTTP 502).",
    });
  });

  it("clears the stored token on 401 so the app returns to login", async () => {
    auth.set("stale");
    const listener = vi.fn();
    auth.subscribe(listener);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          json({ error: { code: "unauthorized", message: "Invalid admin token." } }, 401),
        ),
    );

    await expect(request("GET", "/admin/providers")).rejects.toMatchObject({ status: 401 });
    expect(auth.token()).toBeNull();
    expect(listener).toHaveBeenCalled();
  });

  it("reports an unreachable server as a network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(request("GET", "/admin/providers")).rejects.toMatchObject({
      status: 0,
      code: "network_error",
    });
  });

  it("returns undefined for 204", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(request("DELETE", "/admin/keys/k")).resolves.toBeUndefined();
  });
});

describe("api", () => {
  it("unwraps list envelopes and encodes alias path segments separately", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ data: [{ alias: "a", targets: [] }] }))
      .mockResolvedValueOnce(json({ alias: "team/fast model" }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await api.aliases()).toEqual([{ alias: "a", targets: [] }]);
    await api.putAlias("team/fast model", [{ provider: "p", model: "m" }]);
    expect((fetchMock.mock.calls[1] as [Request])[0].url).toBe(
      "http://router.test/admin/aliases/team/fast%20model",
    );
  });
});
