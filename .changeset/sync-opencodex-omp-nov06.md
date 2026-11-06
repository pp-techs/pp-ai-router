---
"server": minor
---

Sync subscription/OAuth providers with opencodex v2.97.0 (`cab7eb7d0`) and oh-my-pi 18.17.0 (`660a31dc33`).

Antigravity: the quota summary is requested with the Antigravity CLI User-Agent so the Gemini 4 Argon windows show; the thought-signature session (and the `request.sessionId` sent upstream) is scoped by account, so one account's signatures are never replayed to another, and Google's `context_engineering_is_the_way_to_go` bypass token is never recorded as a signature; a 429 without `retry-after` takes it from the body's `RetryInfo.retryDelay` / `quotaResetDelay`; a login that finds no Cloud Code Assist project says why with content-free summaries of each discovery stage; a `MALFORMED_RESPONSE` finish fails the turn instead of looking complete (opencodex `c5c21962d`, `1d91861dc`, `f4a3312ff`, `6c49278cb`; oh-my-pi `7691313248`).

ChatGPT subscription: Codex requests no longer send `OpenAI-Beta: responses=experimental` (codex-rs and omp send it only on the WebSocket handshake), and a custom one is removed; user agent follows omp 18.17.0 (oh-my-pi `b0b02d1120`, `98e356cf99`).

Kiro: a turn refused by Kiro's safety filter (`CONTENT_FILTERED` / `GUARDRAIL_INTERVENED`) ends with `finish_reason: "content_filter"` even when Kiro sent no content, instead of failing as an empty stream and being retried or failed over only to be refused again (opencodex `086f0ab94`).

Anthropic and Claude subscription: a thinking block whose text or signature arrives on `content_block_start` (some Anthropic-compatible endpoints) keeps them, so the signed `thinking_blocks` needed to continue a tool loop are no longer lost; a later `signature_delta` replaces that signature (oh-my-pi `d3d77025b2`, `a405e525e9`). Claude Code identity, betas, OAuth, usage and models are unchanged: oh-my-pi's header/beta refactor is behaviour-identical.
