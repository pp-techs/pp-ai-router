import { all, type Db } from "./db/database.ts";
import type { TokenManager } from "./oauth/token-manager.ts";
import type { CredentialPool } from "./pool/pool.ts";
import type { ProviderAdapter } from "./providers/adapter.ts";
import { isRecord } from "./providers/anthropic/json.ts";
import type { Registry } from "./registry.ts";
import { mergeHeaders } from "./upstream-headers.ts";

export interface ModelTestResult {
  /** The upstream answered 2xx. */
  ok: boolean;
  /** Upstream HTTP status; null when nothing came back (no credential, transport error, timeout). */
  status: number | null;
  latencyMs: number;
  /** Why it failed: the upstream's message, or the router's own reason. */
  error: string | null;
  /** Start of the model's answer, when it gave text. */
  reply: string | null;
  /** Label of the credential that served the request (or the last one that refused it). */
  credential: string | null;
  testedAt: number;
}

interface TestRow {
  model_id: string;
  ok: number;
  status: number | null;
  latency_ms: number;
  error: string | null;
  reply: string | null;
  credential: string | null;
  tested_at: number;
}

/** Longest the router waits for a test answer, whatever `UPSTREAM_TIMEOUT_MS` is. */
const MAX_TEST_TIMEOUT_MS = 60_000;
const MAX_TEXT = 300;
const REPLY_CHARS = 120;
const PROMPT = "Reply with the single word: ok";
/** Enough for a short answer; a reasoning model may spend it all thinking, which still proves the model runs. */
const MAX_TOKENS = 32;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Message of an upstream error body (`{error:{message}}`, `{error:"…"}`, `{message}` or plain text). */
function upstreamMessage(text: string): string {
  const json = parseJson(text);
  if (isRecord(json)) {
    if (typeof json.error === "string") return json.error;
    if (isRecord(json.error) && typeof json.error.message === "string") return json.error.message;
    if (typeof json.message === "string") return json.message;
  }
  return text;
}

function replyOf(text: string): string | null {
  const json = parseJson(text);
  if (!isRecord(json) || !Array.isArray(json.choices)) return null;
  const choice: unknown = json.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) return null;
  const content = choice.message.content;
  return typeof content === "string" && content.trim() ? clip(content.trim(), REPLY_CHARS) : null;
}

/**
 * Sends one tiny, non-streaming request to `provider/model` through the provider's own credentials and
 * records what came back, so an operator can see which listed (or hand-added) models really work. Not
 * metered or billed (no virtual key), and credential health is left alone: a test is a diagnosis, not
 * traffic, so it never puts a credential on cooldown.
 */
export class ModelTester {
  readonly #db: Db;
  readonly #registry: Registry;
  readonly #pool: CredentialPool;
  readonly #tokens: TokenManager;
  readonly #adapters: Readonly<Record<string, ProviderAdapter>>;
  readonly #timeoutMs: number;
  readonly #now: () => number;

  constructor(
    db: Db,
    registry: Registry,
    pool: CredentialPool,
    tokens: TokenManager,
    adapters: Readonly<Record<string, ProviderAdapter>>,
    upstreamTimeoutMs: number,
    now: () => number = Date.now,
  ) {
    this.#db = db;
    this.#registry = registry;
    this.#pool = pool;
    this.#tokens = tokens;
    this.#adapters = adapters;
    this.#timeoutMs = Math.min(upstreamTimeoutMs, MAX_TEST_TIMEOUT_MS);
    this.#now = now;
  }

  /** Latest result of every tested model of a provider, by model id. */
  latest(providerId: string): Map<string, ModelTestResult> {
    return new Map(
      all<TestRow>(
        this.#db.prepare(
          "SELECT model_id, ok, status, latency_ms, error, reply, credential, tested_at FROM model_tests WHERE provider_id = ?",
        ),
        providerId,
      ).map((r) => [
        r.model_id,
        {
          ok: r.ok === 1,
          status: r.status,
          latencyMs: r.latency_ms,
          error: r.error,
          reply: r.reply,
          credential: r.credential,
          testedAt: r.tested_at,
        },
      ]),
    );
  }

  /** Runs one test and stores it (replacing the model's previous result). */
  async test(providerId: string, modelId: string): Promise<ModelTestResult> {
    const startedAt = this.#now();
    const outcome = await this.#run(providerId, modelId).catch((error: Error): Outcome => ({
      ok: false,
      status: null,
      error: error.message,
      reply: null,
      credential: null,
    }));
    const result: ModelTestResult = {
      ...outcome,
      latencyMs: Math.max(0, this.#now() - startedAt),
      testedAt: this.#now(),
    };
    this.#db
      .prepare(
        `INSERT INTO model_tests (provider_id, model_id, ok, status, latency_ms, error, reply, credential, tested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider_id, model_id) DO UPDATE SET ok = excluded.ok, status = excluded.status,
           latency_ms = excluded.latency_ms, error = excluded.error, reply = excluded.reply,
           credential = excluded.credential, tested_at = excluded.tested_at`,
      )
      .run(
        providerId,
        modelId,
        result.ok ? 1 : 0,
        result.status,
        result.latencyMs,
        result.error,
        result.reply,
        result.credential,
        result.testedAt,
      );
    return result;
  }

  async #run(providerId: string, modelId: string): Promise<Outcome> {
    const provider = this.#registry.provider(providerId);
    const adapter = provider && this.#adapters[provider.type];
    if (!provider || !adapter) throw new Error("Provider not found.");
    if (!provider.enabled) throw new Error("Provider is disabled.");

    const tried = new Set<string>();
    let last: Outcome = {
      ok: false,
      status: null,
      error: "No upstream credential is currently available.",
      reply: null,
      credential: null,
    };
    for (let attempt = 0; attempt < provider.maxKeyAttempts; attempt++) {
      const acquired = this.#pool.acquire(providerId, {
        model: modelId,
        scope: adapter.modelScope?.(modelId),
        exclude: tried,
      });
      if ("error" in acquired) {
        if (tried.size === 0) {
          last = {
            ...last,
            error:
              acquired.error === "no_credential"
                ? "No credential is available for this model (none enabled and active, or all cooling down)."
                : "Provider is disabled.",
          };
        }
        break;
      }
      const { lease } = acquired;
      const credential = lease.credential;
      tried.add(credential.id);
      try {
        const send = async (
          token: string,
          meta: Readonly<Record<string, string>>,
          maxKey: string,
        ) =>
          adapter.call({
            baseUrl: provider.baseUrl,
            token,
            meta,
            headers: mergeHeaders(provider.headers, credential.headers),
            body: {
              model: modelId,
              messages: [{ role: "user", content: PROMPT }],
              [maxKey]: MAX_TOKENS,
            },
            stream: false,
            signal: AbortSignal.timeout(this.#timeoutMs),
          });
        let auth = await this.#tokens.resolve(credential, provider.type);
        let res = await send(auth.token, auth.meta, "max_tokens");
        if (res.status === 401 && credential.auth.type === "oauth") {
          await res.body?.cancel().catch(() => {});
          auth = await this.#tokens.refreshNow(credential, provider.type);
          res = await send(auth.token, auth.meta, "max_tokens");
        }
        let text = await res.text().catch(() => "");
        if (res.status === 400 && text.includes("max_completion_tokens")) {
          // Newer OpenAI models refuse `max_tokens`.
          res = await send(auth.token, auth.meta, "max_completion_tokens");
          text = await res.text().catch(() => "");
        }
        last = {
          ok: res.ok,
          status: res.status,
          error: res.ok
            ? null
            : clip(upstreamMessage(text).trim() || `HTTP ${res.status}`, MAX_TEXT),
          reply: res.ok ? replyOf(text) : null,
          credential: credential.label,
        };
        // Only a refusal that is the credential's own (auth, quota, outage) is worth another key.
        const credentialFault =
          res.status === 401 ||
          res.status === 403 ||
          res.status === 408 ||
          res.status === 429 ||
          res.status >= 500;
        if (res.ok || !credentialFault) return last;
      } catch (error) {
        last = {
          ok: false,
          status: null,
          error: clip(error instanceof Error ? error.message : String(error), MAX_TEXT),
          reply: null,
          credential: credential.label,
        };
      } finally {
        lease.release();
      }
    }
    return last;
  }
}

type Outcome = Omit<ModelTestResult, "latencyMs" | "testedAt">;
