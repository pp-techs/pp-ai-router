# server

## 0.19.0

### Minor Changes

- 1e7d36d: ChatGPT subscription: a rate-limit 429 now takes its retry hint only from `error.resets_at` or a header window that is exhausted, not from a plan window that still has headroom; credit-billed seats are read from `spend_control.individual_limit` as a `Spend cap` window (no credit overage when the cap shows no headroom); array tool schemas without `items` get `items: true`; user agent follows omp 18.13.2; `gpt-6.1-terra` is listed (oh-my-pi `58da9df47f`, `d698106d95`, `9810521fa9`, `2ff15b2c21`, `b1ef4170c8`, `e00ec482ef`).

  Antigravity: the `aicode` OAuth scope is requested, and in-band stream error frames keep their status and details in the error message (oh-my-pi `917a365890`, `e2f9f9b914`).

  Kiro: `OVERAGE_REQUEST_LIMIT_EXCEEDED` is mapped to 429 `insufficient_quota` like `MONTHLY_REQUEST_COUNT`; `gpt-6.1-terra` gets the native reasoning effort field (opencodex `5ab431bec`, `2606f6f92`). Anthropic and Claude subscription: upstream changes since the last sync do not touch their wire behaviour.

## 0.18.0

### Minor Changes

- dab988f: Anthropic and Claude subscription: a tool whose root schema is a `oneOf`/`anyOf`/`allOf` now keeps every declaration of a property that its variants declare differently (nested `anyOf`, `allOf` for a root `allOf`; a declaration also present on the root is combined with it under `allOf`) instead of the last one winning, and requires the keys every `anyOf`/`oneOf` variant requires (oh-my-pi `0d20eee217`). The opencodex changes since `994d15e8a` do not touch the Antigravity, Kiro or ChatGPT wire behaviour.

## 0.17.0

### Minor Changes

- 94bf42a: New provider `chatgpt-subscription` ("ChatGPT (Plus/Pro, Codex)"): OpenAI models (`gpt-6.1-sol`, `gpt-6-*`, `gpt-5.6-*`, `gpt-5.5`) billed to a signed-in ChatGPT Plus/Pro/Team account through the Codex backend. PKCE paste login against the Codex CLI client, chat-completions to Responses translation with SSE mapped back, `wham/usage` account quota with a separate Spark scope, and `x-codex-*` rate-limit headers observed per answer. Ported from opencodex v2.83.0-251; the Codex CLI identity and JWT claims follow oh-my-pi. Nothing was exercised against a live account.

  Sync with opencodex v2.83.0-251 (`dd2bdd2fe`) and oh-my-pi (`9d5d4ac5b`). Antigravity: the Gemini 4 Argon quota group is shown as its own `Argon 5h` / `Argon weekly` windows instead of replacing the Gemini readings. Claude Subscription: `X-Stainless-Runtime-Version` is pinned to `v26.3.0` and the random `x-client-request-id` is no longer sent, as oh-my-pi does. Kiro and Anthropic (API key) needed no change.

  Provider types and labels now follow the product names: `anthropic-subscription` is `claude-subscription` ("Claude (Pro/Max)"; migration 009 renames existing providers, so API clients that create or filter by that type must use the new one), and the labels read "Anthropic API", "OpenAI-compatible API" and "Kiro (AWS)".

  `claude-subscription` and `chatgpt-subscription` now follow oh-my-pi (`9d5d4ac5b`) as the primary reference, opencodex secondary. Claude: model discovery sends omp's account-route betas, Messages requests pick the agent or utility beta set per request and carry `tools: []`, gzip `Accept-Encoding` and a 1h identity-block cache breakpoint, usage windows fall back to `session`/`weekly_all` and use the proxied API root, and OAuth tokens expire 5 minutes early; a token response without `expires_in` and refresh refusals other than the omp set (`invalid_grant`, `invalid_token`, `unauthorized_client`, `revoked`, expired, bare 401) no longer retire the account. ChatGPT: the request presents as omp (`originator: omp`, `omp/<version>` user agent, `client_metadata`, session/thread/window headers), default `base_url` is `https://chatgpt.com/backend-api` (`.../codex` keeps working), tool schemas are sanitised, `cyber_policy` answers become 403 so another account is tried, plain 429s are `rate_limit_exceeded`, and `gpt-5.5` left the static model list (any id still passes through).

## 0.16.0

### Minor Changes

- 222614e: Sync subscription/OAuth providers with opencodex v2.83.0-220 (`6936d9885`). Antigravity: when a Gemini model replays an assistant turn that made tool calls, only the first sentence of its pre-call progress text is sent back to Google, so leaked planning text no longer compounds through the history (Claude and gpt-oss models and the client-facing response are unchanged). Kiro and Anthropic subscription needed no code change; the Anthropic README now records which upstream Responses-lane fixes are deliberately not ported.

## 0.15.1

No changes in this release.

## 0.15.0

### Minor Changes

- 7a0ec9c: Sync subscription/OAuth providers with opencodex v2.83.0-130 (`409026b1b`). Antigravity: new models `gemini-4-argon`, `claude-opus-5-5` and `claude-sonnet-5-5` (per-tier `-low/-medium/-high` wire ids, effort rides the suffix; the existing models stay listed). Gemini 4 Argon requests carry the Antigravity CLI User-Agent, which Cloud Code Assist serves it to exclusively; every other model keeps the IDE one. Kiro: a desktop-refresh answer of HTTP 401 with `{"message":"Bad credentials"}` is now a terminal refresh failure (`bad_credentials`), so the credential is marked dead instead of retried. Anthropic subscription needed no change (Claude Code 2.1.280 and SDK 0.112.1 already match opencodex and oh-my-pi).

## 0.14.0

### Minor Changes

- 5008d39: Custom models and model tests. Models page: "Add model" (toolbar or any provider group) creates a model by hand with every fact a listed model has (id, name, description, release date, context window, max output, input/output modalities, supported parameters); custom models are tagged, editable and deletable from the row menu, join the provider's list (so they survive refreshes, also on built-in lists) and are offered on `/v1/models`. Each row has "Test model" (and "Set price…"), each group and the toolbar have "Test all" (or "Test shown" while filtering) for the enabled models, run four at a time with progress and Stop, and a confirmation above ten; the last result (latency, or status and error) stays in a Test column. Server: `PUT|DELETE /admin/models/:provider/:model` for custom models (tables `custom_models`, `model_tests`), `POST /admin/model-tests {provider, model}` sends one tiny request through the provider's credentials without metering it or touching credential health, and the admin model lists carry `custom` and `last_test`.

## 0.13.0

### Minor Changes

- e79ed58: Models page: rows are one line (no description or release date; modalities and the parameter count are tags in their own column), provider groups collapse (with Collapse all / Expand all), and each group has Disable all / Enable all to switch a whole provider's list at once, e.g. everything on OpenRouter except a few models. With a search or status filter on, the buttons act on the models shown. Server: `PATCH /admin/models/:provider` `{enabled, models?}` switches many models in one call (`models` omitted = every model the provider lists).

## 0.12.0

### Minor Changes

- deb5fcb: Custom upstream headers. A provider carries a `headers` map (JSON in the new `providers.headers`, `credentials.headers` columns) that every request to it sends — chat completions, the model-list fetch and the OAuth account-quota probe — and each credential carries its own map that overrides the provider's per name, so one API key can send a different value for a header than its siblings. The admin API validates both: names must be HTTP tokens, values single-line (at most 20 headers, 1000 characters each), and the headers that frame the request or the connection (`host`, `content-length`, hop-by-hop ones) are refused. An adapter applies the merge last, so a custom header can deliberately override one the adapter itself sets. Header values are stored unencrypted per provider/credential and never written to the audit log, only their names. The Add provider, Edit provider, Add API key and Edit credential dialogs edit them as name/value rows.

  `PATCH /admin/providers/:id` no longer resets the fields a body leaves out: the request schema's defaults used to apply to a partial patch, so toggling a provider from the Providers page silently reset its `key_strategy`, `sticky_ttl_sec` and `max_key_attempts`.

  Dialogs no longer let a form widen them past their max width: the shared dialog body is a single `minmax(0, 1fr)` column whose children may shrink, and the alias editor's target rows are `minmax(0, …)` tracks that stack on narrow screens instead of forcing the popup wider.

## 0.11.0

### Minor Changes

- 411aac0: Anthropic Subscription now presents the Claude Code request the way oh-my-pi does, which tracks the CLI more closely than opencodex. Requests go to `/messages?beta=true` with the CLI user agent, SDK version, `x-app`/`anthropic-dangerous-direct-browser-access` headers, the CLI beta set (`effort` added when the request thinks, `context-1m` never) and a `metadata.user_id` naming the device, a per-conversation session and the account. The system prompt starts with the signed billing block (`cc_version`, first-turn fingerprint, `cch` XXH64 attestation) and the `You are Claude Code…` identity. Client tools are wrapped with the `_` prefix instead of `custom_`. A `claude_code_version_too_old` rejection moves the presented version up and resends once. Sign-in asks for the six current scopes and records the organization (completed from `/api/claude_cli/bootstrap` when the token response omits it); refreshes send the SDK's OAuth headers. The usage probe uses the CLI's betas and reads Mythos weekly limits. Request bodies may now be sent as bytes (`PreparedRequest`) by a provider flavor.

  The credential pool understands model scopes (`ProviderAdapter.modelScope`, `QuotaWindow.scope`, `Quota.complete`). For Anthropic Subscription, Opus, Sonnet, Fable and Mythos are scopes: a spent family window parks that family only, a Fable/Mythos 429 cools the account for that family only, and a complete usage reading lifts that cooldown early. Every Claude answer's `anthropic-ratelimit-unified-*` headers are read (`UpstreamCall.observe` → `QuotaService.observe`) and park the account, or the Fable scope, as soon as a window reads 100% instead of at the next probe.

## 0.10.0

### Minor Changes

- 2bb1d0b: Per-model limits on API keys. A limit may carry a `model` glob (e.g. `openai/gpt-4o`, `claude-*`; null = every model) matched against the requested model: it only gates requests for matching models and counts only their usage, for any metric (USD, input/output/total tokens, requests) and window. Per-model usage is tracked in `usage_model_buckets` and seeded from the ledger on upgrade. The admin API and the 429 `limit_exceeded` error report the limit's `model`; the keys page can set it.
- 38964b7: API keys can be rotated and edited from the Keys page. `POST /admin/keys/:id/rotate` issues a new secret for the same key (id, limits and usage history are kept; the old secret stops working at once, the new one is shown once). A new Edit dialog changes a key's name, allowed models and expiry.

## 0.9.0

### Minor Changes

- 1a57522: Subscription/OAuth providers synced with opencodex v2.83.0. Anthropic and Anthropic Subscription: Haiku 5.5 / Sonnet 5.5 model contracts, thinking-off handling per model, `response_format: json_schema` as `output_config.format`, `reasoning_tokens`, `refusal`/`error` stop reasons, more terminal refresh errors. Antigravity: one replay of a 400 that blames tool schemas or thinking config, model context windows and input modalities. Kiro: usage probe region from the profile ARN, per-minute rate limits no longer treated as spent quota, 400 expired-token mapped to 401, image token estimate from dimensions.

## 0.8.0

### Minor Changes

- 634241f: Model lists now carry details: description, created, context window, max output tokens, input/output modalities and supported parameters, read from the upstream and filled in from OpenRouter's catalog where it is silent. Exposed on `GET /v1/models` (OpenRouter-style fields, `?verbose=1` for descriptions), the admin model lists (with `sources`), and the models page.

## 0.7.0

### Minor Changes

- 35707c5: Anthropic Subscription provider (`anthropic-subscription`), following opencodex: Claude models billed to a signed-in Claude Pro/Max account. Paste-flow PKCE sign-in and refresh, the Claude Code identity on every request (betas, headers, first system block, `custom_` tool-name wrapping), model discovery, and account quota (5-hour, weekly and per-model windows) that parks a spent account until it resets. The Messages translation is shared with the `anthropic` provider (`createAnthropicAdapter`).

## 0.6.0

### Minor Changes

- e9b031f: Add audit log and loggers feature for tracking administrative operations and gateway traffic events with dedicated audit log dashboard page.

## 0.5.0

### Minor Changes

- 90360b9: Models page: `/models` now lists every model all providers offer (group by provider or one flat list, search by provider/id/name, filter enabled/disabled) with a switch to turn each model off; aliases moved to a `/models/aliases` tab. Server: new `disabled_models` table, `GET /admin/models` (all providers' stored lists) and `PATCH /admin/models/:provider/:model` `{enabled}`. A disabled model is not routed to (404 `model_not_found`, skipped inside aliases so fallbacks still work) and is hidden from `/v1/models`; an alias disappears there when all its targets are disabled. Provider model lists now carry an `enabled` flag.

### Patch Changes

- 90360b9: Server: price lookup now also tries other spellings of a model id when nothing matches exactly: `.` and `-` between version digits (`claude-sonnet-5.5` finds LiteLLM's `claude-sonnet-5-5`), a dropped `.0`, and the vendor prefix OpenRouter uses (`anthropic/…`, `openai/…`, `deepseek/deepseek-v3.2`). An exact id in any source still wins over a derived one, and overrides on the id as written win over both. Kiro's Claude 4.x/5.5 models and others that were billed as unpriced now get a price.

## 0.4.2

### Patch Changes

- 1925772: Admin UI: select options show readable labels instead of raw ids (credential strategy "Round robin", limit windows "1 day", "Total", "Custom…", modes "Fixed (UTC)" / "Rolling"), and the select trigger is back to the plain Base UI `items` pattern. Server: Kiro model list adds `claude-sonnet-5.5` and `claude-opus-5.5` (1M context) and documents which announced ids are intentionally left out.

## 0.4.1

### Patch Changes

- 97ff8c1: Admin UI: scrollbars follow the app theme (light/dark toggle) instead of the OS preference and are thinner; select triggers always show the option label and never fall back to the raw value.

## 0.4.0

### Minor Changes

- 6a8b9a3: Admin UI: migrate to TanStack Router with file-based routes, adopt the shadcn `sidebar-08` inset layout (collapsible sidebar, header breadcrumb, user menu), move global settings (pricing, appearance, account) into a `sidebar-13` settings dialog opened with `?settings=`, replace the flat per-row buttons in tables with a dropdown menu (API keys are now a table too), and add a usage chart (requests, tokens or cost over time) on the Usage and Overview pages. Server: `GET /admin/usage/timeline` returns usage bucketed by `bucket_ms`.

## 0.3.0

No changes in this release.

## 0.2.0

### Minor Changes

- c1e1f3b: Account quota for OAuth providers (Kiro, Google Antigravity), following opencodex: `GET /admin/providers/:id/quota` and `GET /admin/credentials/:id/quota` report each account's remaining allowance (usage windows, Kiro credits, reset times), cached and re-read every `QUOTA_SYNC_INTERVAL_MINUTES` (default 30). An account whose allowance is spent is taken out of rotation until its quota resets, and a 429 from an OAuth account triggers a check so failover and parking happen immediately. The admin UI shows a Quota card on the provider page. The web unit tests now run in CI (`apps/web` gains a `test` script).

## 0.1.0

### Minor Changes

- 89c95f7: Initial release: OpenAI- and Anthropic-compatible router with virtual keys, budgets, multi-credential pooling and model pricing; Anthropic, Kiro and Google Antigravity providers (adapted from [lidge-jun/opencodex](https://github.com/lidge-jun/opencodex)); admin UI and single-image Docker deployment.
