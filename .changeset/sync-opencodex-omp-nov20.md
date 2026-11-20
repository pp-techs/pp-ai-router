---
"server": minor
---

Sync subscription/OAuth providers with opencodex `d61cca122` (v2.100.6-2) and oh-my-pi `725f8c6f34` (19.0.1).

Antigravity: a 429 `retry-after` hint accepts Go/protobuf compound durations (`1m30s`, `500ms`), prefers a typed `RetryInfo` over `quotaResetDelay` over untyped details, and falls back to a "retry after <duration>" phrase in the message; `UNEXPECTED_TOOL_CALL` and `MALFORMED_RESPONSE` finishes fail the turn only when nothing was delivered (afterwards `MALFORMED_RESPONSE` ends as `content_filter`, `UNEXPECTED_TOOL_CALL` as a normal stop); `IMAGE_SAFETY` and `IMAGE_PROHIBITED_CONTENT` map to `content_filter` (opencodex `45c512dbd`, `e73546464`).

Kiro: an upstream "Input is too long." body is reported as `context_length_exceeded` on any status, and the quota probe no longer marks an account exhausted while an unexpired purchased add-on has credit left (oh-my-pi `739d75821a`, `49e0bc63bf`, `9d3cb07936`, `39a516ad8d`).

ChatGPT subscription: user agent follows omp 19.0.1; the pinned Codex client version stays `0.169.0` (oh-my-pi `6dcf164d2c`). Anthropic and Claude subscription: upstream changes since the last sync do not touch their wire behaviour.
