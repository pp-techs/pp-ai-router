---
"server": minor
---

Sync subscription providers with opencodex v2.100.3-87 (`04304da28`) and oh-my-pi 18.22.2 (`e1ae2cc998`).

ChatGPT subscription: the Codex client version moves to 0.169.0 (user agent `omp/18.22.2`); the request body leads with `model` and `stream` ahead of `input`, and the base instructions travel as the leading `model.base_instructions` developer message of `input` with codex-rs's deterministic id instead of a top-level `instructions`, as codex-rs does since 0.161/0.162; a token refresh sends `refresh_reason` (`proactive_expiry`, or `unauthorized_recovery` after a 401); `gpt-6.2-astra` and `gpt-6.2-sol` are listed. `OAuthProvider.refresh` gains an optional `reason` the token manager fills in.

Claude subscription: the presented Claude Code version is 2.1.326; Fable and Mythos are metered by one model-scoped weekly counter, so the single row Anthropic reports (labelled Fable) now parks and heals both families' scopes, as oh-my-pi judges them; the usage probe and the identity bootstrap refuse redirects so the account's bearer cannot be sent to another host.

Kiro: `claude-opus-5.5` keeps the twelve schema keywords production traffic showed it accepts (`additionalProperties`, `pattern`, `format`, length/range bounds, `propertyNames`, `$schema`, ...) instead of only `pattern` and `maximum` (opencodex `74814bd69`).

Antigravity: no wire change; the README's account-suspension caution follows opencodex's new sign-in acknowledgement. The four OAuth flows were re-verified at both upstreams; the only drift was ChatGPT's `refresh_reason`.
