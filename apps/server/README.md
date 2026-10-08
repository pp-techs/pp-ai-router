# server

LLM router: one OpenAI-compatible endpoint in front of many upstream providers, with virtual keys, budgets and pricing.
Node 24+ (runs `.ts` directly via type stripping), Hono, `node:sqlite`, Zod.

```bash
cp .env.example .env        # fill MASTER_KEY and ADMIN_TOKEN, then export them
vp run server#dev           # or: node src/main.ts
vp test                     # in apps/server
```

## Concepts

|                 |                                                                                                                                                                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Provider**    | Upstream endpoint (`type: openai-compat`) with a `key_strategy`: `round_robin`, `weighted`, `least_inflight`, `least_used`, `fill_first`, `random`. `sticky_ttl_sec > 0` pins a session (`x-session-id`, `prompt_cache_key` or `user`) to one credential. |
| **Credential**  | One upstream API key (many per provider; AES-256-GCM at rest). `weight`, `priority`, `models` globs, `rpm_limit`. 429/5xx -> cooldown with backoff (or `Retry-After`); 401 -> `dead` until the secret is replaced.                                        |
| **Alias**       | Public model name -> ordered `[{provider, model}]`; later targets are fallbacks. `provider/model` also works without an alias.                                                                                                                            |
| **Virtual key** | `sk-pp-…` handed to clients; only its SHA-256 is stored. Optional `allowed_models` globs and `expires_at`.                                                                                                                                                |
| **Limit**       | Per key: `metric` (`usd`, `input_tokens`, `output_tokens`, `total_tokens`, `requests`) x `window` (`30m`, `1h`, `1d`, `7d`, `total`) x `mode` (`fixed` = UTC-aligned, `rolling`).                                                                         |
| **Pricing**     | LiteLLM + OpenRouter synced daily (ETag), manual overrides win. Cost handles cached/reasoning tokens and long-context tiers.                                                                                                                              |

## API

Client: `POST /v1/chat/completions` (JSON or SSE), `GET /v1/models`, `GET /healthz`. Auth: `Authorization: Bearer sk-pp-…`.

Admin (`Authorization: Bearer $ADMIN_TOKEN`):

```
GET|POST   /admin/providers            PATCH|DELETE /admin/providers/:id
GET|POST   /admin/providers/:id/credentials     PATCH|DELETE /admin/credentials/:id
GET        /admin/providers/:id/models          POST /admin/providers/:id/models/refresh
GET        /admin/aliases              PUT|DELETE   /admin/aliases/:alias
GET|POST   /admin/keys                 GET|PATCH|DELETE /admin/keys/:id
POST       /admin/keys/:id/limits      DELETE /admin/limits/:id
GET        /admin/usage                GET /admin/usage/summary?group_by=model|provider|key
GET        /admin/pricing?q=           GET /admin/pricing/lookup?model=   GET|POST /admin/pricing/sync
GET|PUT|DELETE /admin/pricing/overrides
```

```bash
A='authorization: Bearer '$ADMIN_TOKEN; J='content-type: application/json'
curl -H "$A" -H "$J" localhost:8080/admin/providers -d '{"id":"openai","type":"openai-compat","base_url":"https://api.openai.com/v1","key_strategy":"weighted"}'
curl -H "$A" -H "$J" localhost:8080/admin/providers/openai/credentials -d '{"label":"main","secret":"sk-…","weight":3}'
curl -H "$A" -H "$J" localhost:8080/admin/keys -d '{"name":"alice","limits":[{"metric":"usd","window":"1d","max":5},{"metric":"total_tokens","window":"1h","mode":"rolling","max":200000}]}'
```

## Models

Each provider's model list is available from `GET /admin/providers/:id/models` (with `$/1M` prices joined in) and, for clients, as `provider/model` entries in `GET /v1/models` next to the aliases (filtered by the key's `allowed_models`).

- **OpenAI-compatible and Anthropic providers** are fetched from the upstream (`GET {base_url}/models`, Anthropic paginated) with one of the provider's active credentials, trying up to three. The result is stored in SQLite, so listing never waits on the network and survives restarts. It is fetched on the first view, on `POST …/models/refresh`, at startup and every `MODEL_SYNC_INTERVAL_HOURS` (default 6, `0` = on demand only). A failed refresh keeps the previous list and reports the error. The parser accepts `{data:[…]}`, `{models:[…]}`, bare arrays, string entries and `context_length`/`context_window`.
- **OAuth providers (Kiro, Antigravity)** have a fixed built-in list (`src/providers/kiro/models.ts`, `src/providers/antigravity/models.ts`), because their backends offer no discovery we can call per account. Any other id still works as `provider/<id>`: requests are routed by name whether or not it is listed.

## Behaviour worth knowing

- Limits are checked before a request and recorded after it, so concurrent in-flight requests can overshoot by their own cost.
- Streaming: the router adds `stream_options.include_usage`. A stream that ends without a usage chunk (client abort, provider without usage) is logged as `aborted`/`no_usage` with 0 tokens.
- Unknown model price: billed $0 and flagged `price_source=unknown` (`UNPRICED_MODELS=reject` refuses instead). Cooldown state is in memory; `dead` credentials persist.
- Single process by design: counters live in SQLite and pool state in memory.

## Anthropic

**Outbound**: provider type `anthropic` (default `base_url` `https://api.anthropic.com/v1`, credentials are API keys sent as `x-api-key` with `anthropic-version: 2023-06-01`). The router's OpenAI request is translated to `POST {base_url}/messages` and the Messages response/SSE back to chat completions, including `reasoning_content`, tool calls and `cache_control` on content parts, tools and messages.

- `max_tokens` is mandatory upstream: `max_tokens` / `max_completion_tokens`, else 8192 (or the thinking budget + 8192). `temperature`/`top_p` are clamped to 0..1, and dropped where the model rejects them (thinking enabled, Opus 4.7+, Sonnet 5+).
- Thinking: `thinking` (Anthropic shape) or `reasoning_effort` select it. Models that only accept adaptive thinking get `thinking: adaptive` + `output_config.effort`; older ones get a `budget_tokens` below `max_tokens`. Signed thinking blocks travel in the non-standard `thinking_blocks` field (response and request) so tool loops keep working; without them a manual-budget request drops thinking instead of failing.
- Usage: `prompt_tokens` = `input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens` (OpenAI semantics), so cache reads/writes are priced at their own rates.
- Histories OpenAI clients may send but Anthropic rejects are repaired: orphan tool results become text, unanswered tool calls get an error result. Unsupported content (non-http/data image URLs) yields Anthropic's 400 without an upstream call.

**Inbound**: `POST /v1/messages` (JSON or SSE) accepts Anthropic requests (`x-api-key` or `Authorization: Bearer` with a virtual key), so Claude Code and the Anthropic SDKs work against the router: `ANTHROPIC_BASE_URL=http://router:8080 ANTHROPIC_API_KEY=sk-pp-…`. It runs the same pipeline as chat completions (limits, aliases/routing, credential pool, accounting) against **any** provider type, and answers in Anthropic's format with `{type:"error",error:{type,message}}` errors. `top_k` and `thinking` are forwarded to the upstream as extra fields (an OpenAI-compat upstream that rejects unknown fields will 400). Server tools (`web_search_*`, ...) and `count_tokens` are not supported.

## Antigravity

Provider type `antigravity` ("Google Antigravity"): Gemini, Claude and gpt-oss models through Google's Cloud Code Assist backend (`v1internal`), billed to the signed-in Google account's Antigravity subscription. Ported from [lidge-jun/opencodex](https://github.com/lidge-jun/opencodex) (MIT). It is not an official API: the OAuth client and request shape mimic the Antigravity desktop IDE, and Google can change or block that at any time.

```bash
curl -H "$A" -H "$J" localhost:8080/admin/providers -d '{"id":"agy","type":"antigravity"}'   # base_url defaults to https://daily-cloudcode-pa.googleapis.com
curl -H "$A" -H "$J" localhost:8080/admin/providers/agy/oauth/start -d '{}'                   # -> { session_id, auth_url, ... }
# open auth_url, sign in; the browser then lands on http://127.0.0.1:51121/callback?code=…&state=… which cannot load: that is expected.
curl -H "$A" -H "$J" localhost:8080/admin/oauth/sessions/$SID/complete -d '{"input":"<the full URL from the address bar>"}'
curl -H "authorization: Bearer sk-pp-…" -H "$J" localhost:8080/v1/chat/completions -d '{"model":"agy/gemini-3.8-flash","messages":[{"role":"user","content":"hi"}]}'
```

- **Login** is a paste flow (the router is remote, so nothing listens on the registered `127.0.0.1:51121` redirect). The pasted text may be the full URL, its query string, `code#state` or the bare code; a URL/query must carry the `state` of the login that was started, otherwise it is refused and the session stays pending. PKCE (S256) is used. After the code exchange the Cloud Code Assist project is discovered (`loadCodeAssist`, then `onboardUser` with the free tier); an account without a project is refused. The project id is stored with the account (`project_id`).
- **Refresh**: `invalid_grant` / `invalid_client` / `unauthorized_client` retire the account until it signs in again; anything else (5xx, 429, network, other 4xx) is transient and only cools it down.
- **Models**: the upstream model name is mapped like the reference: `gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.1-pro`, `gemini-3.1-flash-image`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`, plus wire ids/aliases (`gemini-pro-agent`, `gemini-3.8-flash-high`, retired `gemini-3.6-flash*` -> 3.7). `reasoning_effort` (`low|medium|high`; `xhigh`/`max` clamp to `high`) selects the effort wire id or `thinkingLevel`; unknown ids are sent as-is. When the client sends `reasoning_effort` (other than `none`) to a Gemini model, thought summaries are requested and returned as `reasoning_content`.
- **Request mapping**: system/developer messages -> `systemInstruction`; images / `input_audio` / `file` data URLs -> `inline_data` (remote image URLs become a text marker); tools -> function declarations with schemas reduced to the subset Google accepts (`$ref` inlined, `anyOf` normalised, unsupported keywords dropped, tool names rewritten to Google-legal ones and mapped back); `tool_choice`, `stop`, `max_(completion_)tokens`, `temperature`, `top_p` and `response_format` (Gemini only) are honoured. Tool results are regrouped after their call; a history that opens on a tool call or ends on a model turn gets a `(continue)` user turn.
- **Usage**: Google reports `promptTokenCount` including cached tokens and `candidatesTokenCount` excluding thinking tokens. They are converted to OpenAI semantics: `prompt_tokens` includes cached (`cached_tokens` is the cached part), `completion_tokens` = candidates + thoughts (`reasoning_tokens` is the thoughts part).
- **Thought signatures**: Gemini 3 needs the `thoughtSignature` of a function call echoed back. OpenAI clients cannot carry it, so it is remembered in memory (per model + session derived from the first user message, keyed by call name + arguments, 1 h TTL) and re-injected when the same call appears in the history; otherwise the first call of a turn gets Google's documented bypass token. A restart forgets the signatures.
- **Errors**: upstream non-2xx responses are returned unchanged (status, body, `retry-after`), so 401 -> refresh once, 403/429/5xx -> cooldown/failover as for any provider. A turn cut off by `MAX_TOKENS` mid tool call, `MALFORMED_FUNCTION_CALL`, or a stream with no terminal frame fails (a stream shows an `error` event) instead of looking complete. Google's `RetryInfo` hints are not translated into `retry-after`.
- **Environment** (optional overrides, read at start): `GOOGLE_ANTIGRAVITY_CLIENT_ID`, `GOOGLE_ANTIGRAVITY_CLIENT_SECRET`, `GOOGLE_ANTIGRAVITY_USER_AGENT`. All constants live in `src/providers/antigravity/constants.ts`.

## Kiro

Provider type `kiro`: Claude, GPT, DeepSeek, GLM, Qwen and MiniMax models through Kiro's CodeWhisperer streaming API (`AmazonCodeWhispererStreamingService.GenerateAssistantResponse`), billed to the signed-in Kiro / AWS Builder ID account. Ported from [lidge-jun/opencodex](https://github.com/lidge-jun/opencodex) (MIT). It is not a public API: the headers and request shape mimic the Kiro CLI / IDE, and Kiro can change or block that at any time.

```bash
curl -H "$A" -H "$J" localhost:8080/admin/providers -d '{"id":"kiro","type":"kiro"}'   # base_url defaults to https://runtime.us-east-1.kiro.dev
curl -H "$A" -H "$J" localhost:8080/admin/providers/kiro/oauth/start -d '{}'            # -> { session_id, user_code, verification_uri(_complete), ... }
# open verification_uri_complete in any browser, sign in with AWS Builder ID, approve; poll until status is "complete":
curl -H "$A" localhost:8080/admin/oauth/sessions/$SID
curl -H "authorization: Bearer sk-pp-…" -H "$J" localhost:8080/v1/chat/completions -d '{"model":"kiro/claude-sonnet-4.5","messages":[{"role":"user","content":"hi"}]}'
```

- **Login** is a device flow (a remote admin only needs a browser): a public SSO OIDC client `kiro-cli` is registered at `oidc.us-east-1.amazonaws.com`, a device grant is started for `https://view.awsapps.com/start`, and the router polls `/token` at the interval the IdP asks for (`slow_down` is honoured; IdP 5xx and network blips keep the login pending until the code expires, at most 15 min). `expired_token` and `access_denied` end it with an error. Stored with the account (`extra`): `authType=aws_sso_oidc`, the client registration (`clientId`, `clientSecret`), `ssoRegion` and `apiRegion` (both `us-east-1`). The contract allows one login flow per provider type, so the Google / GitHub social device logins, importing a local `kiro-cli` database and pasting tokens are not offered; a Kiro API key (`ksk_…`) can still be added as a normal API-key credential, and an account stored without a client registration is refreshed on Kiro's own endpoint.
- **Refresh** (`refresh_token`): with a client registration `POST https://oidc.<ssoRegion>.amazonaws.com/token` `{grantType:"refresh_token", clientId, clientSecret, refreshToken}`; without one `POST https://prod.<ssoRegion>.auth.desktop.kiro.dev/refreshToken` `{refreshToken}`. HTTP 400/401 with `invalid_grant`, `refresh_token_reused`, `revoked`, `revoked_token`, `refresh_token_revoked`, `access_denied` or `expired_token` retires the account until it signs in again; anything else (5xx, 429, network, unknown 4xx) is transient and only cools it down. A rotated refresh token is persisted; error bodies are never echoed.
- **Regions**: the runtime region is `apiRegion`, else the region in the profile ARN, else `ssoRegion`, else `us-east-1`. A canonical `runtime.<region>.kiro.dev` `base_url` follows it; any other `base_url` (proxy, test double) is used as given. When the canonical host cannot be resolved/reached, answers 404/405/502/503/504, or a 400/403 names an unknown operation/signature, the same call is retried once on the older `q.<region>.amazonaws.com` host.
- **Request mapping** (`src/providers/kiro/request.ts`): leading `system`/`developer` messages become a prompt prefixed to the first user message (Kiro has no system role); later ones are folded into the surrounding user turn. History is rebuilt as strictly alternating user/assistant turns (adjacent same-role messages merged, an opening assistant turn or a trailing assistant turn gets a continuation user turn), assistant `tool_calls` become `toolUses` (objects, ids sanitised to `[A-Za-z0-9_-]{1,64}`) and `tool` messages become `toolResults` (empty output becomes a sentence; an orphaned result, a duplicate id or an unanswered call is a 400). Tools become `toolSpecification`s with the schema subset Kiro accepts (rejected keywords dropped, root `oneOf/anyOf/allOf` flattened, names rewritten to legal unique ones and mapped back on the response, descriptions cut to 1024 chars, at most 48 tools / 96 kB, the omitted ones named in the prompt). Data-URL images are sent inline (max 20 per message, 100 per request; the oldest are dropped with a note); remote image URLs become a text marker. The model id is normalised (`kiro-claude-sonnet-4-5` -> `claude-sonnet-4.5`, `kiro-auto` -> `auto`, date/effort suffixes dropped). `reasoning_effort` (or `reasoning.effort`) is sent natively for `gpt-5.6-*`, `gpt-6*` and `claude-opus-5*` (`additionalModelRequestFields`), for every other model it becomes `<thinking_mode>` instructions budgeted from `max_tokens`, and the model's leading `<thinking>` block is returned as `reasoning_content`. Not expressible, so answered with HTTP 400 and no upstream call: `tool_choice` other than `auto`/`none`, `service_tier`, `response_format` other than `text`, `file`/`input_audio`/`video_url` parts. `temperature`, `top_p`, `max_tokens` and `stop` are not sent (the wire has no field for them).
- **Request shape**: accounts with their own profile ARN use the IDE request shape (`x-amzn-kiro-profile-arn`, `origin: AI_EDITOR`); Builder ID accounts (no ARN of their own) and `ksk_` API keys use the CLI shape (`origin: KIRO_CLI`, `agentTaskType: vibe`), Builder ID carrying Kiro's fixed service profile ARN. Every request gets a fresh `conversationId`: the router holds no Kiro conversation state.
- **Response**: the service only streams an AWS binary event-stream (`application/vnd.amazon.eventstream`). `src/providers/kiro/eventstream.ts` decodes it frame by frame across arbitrary chunk boundaries, verifying the prelude and message CRC32 (a bad CRC, a corrupt length or a stream cut mid-frame fails the response). Text, reasoning and tool calls map to OpenAI chunks; a tool call is emitted whole once Kiro marks it stopped and only if its JSON input is complete. Non-streaming clients get the same chunks aggregated. Stop reasons map to `finish_reason` (`MAX_TOKENS` -> `length`, `CONTENT_FILTERED`/`GUARDRAIL_INTERVENED` -> `content_filter`, a tool call -> `tool_calls`); `MODEL_CONTEXT_WINDOW_EXCEEDED`, exception/error frames, protocol violations and an empty stream fail the request (an SSE `error` event once streaming, a failed attempt for non-streaming).
- **Usage**: when the stream carries `metadataEvent.tokenUsage` it is used as reported: `prompt_tokens` = uncached + cache-read + cache-write input tokens (`cached_tokens`, `cache_write_tokens` are the cache parts) and `completion_tokens` = output tokens. Kiro often reports no token counts (only a `contextUsageEvent` percentage and `meteringEvent` credits, neither of which is converted), so otherwise the reference's heuristic is used: prompt tokens estimated from the whole built request (history, tools, tool results, images; latin text 2.8 chars/token x 1.2 wire expansion, CJK 1.5 chars/token, 27 tokens of framing per turn, at least 256 per image) and output tokens from the generated text, reasoning and tool arguments. Estimates err high and are not flagged in the response, so budgets on Kiro accounts are approximate.
- **Errors**: upstream non-2xx is returned with its status in the OpenAI error envelope, so 401 -> refresh once, 403/429/5xx -> cooldown/failover as for any provider; `retry-after` is kept. A 400 `MONTHLY_REQUEST_COUNT` (spent monthly quota) is reported as 429 `insufficient_quota` so the pool rotates to another account, `CONTENT_LENGTH_EXCEEDS_THRESHOLD` as `context_length_exceeded`, and 5xx bodies are replaced by a generic message.
- **Not ported from the reference** (they exist for opencodex's Codex/Responses front end or local-machine integration): the private "final answer" completion tool and text-fallback retry, Responses continuations, reasoning-blob replay (`signature` / `redactedContent` are dropped), per-conversation token calibration, image re-encoding, the process-wide 429 throttle gate and connection-reset retries (the gateway's failover covers them), reading/rotating the local `kiro-cli` database, account leases and failover, and usage-limit lookups.
