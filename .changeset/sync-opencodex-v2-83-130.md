---
"server": minor
---

Sync subscription/OAuth providers with opencodex v2.83.0-130 (`409026b1b`). Antigravity: new models `gemini-4-argon`, `claude-opus-5-5` and `claude-sonnet-5-5` (per-tier `-low/-medium/-high` wire ids, effort rides the suffix; the existing models stay listed). Gemini 4 Argon requests carry the Antigravity CLI User-Agent, which Cloud Code Assist serves it to exclusively; every other model keeps the IDE one. Kiro: a desktop-refresh answer of HTTP 401 with `{"message":"Bad credentials"}` is now a terminal refresh failure (`bad_credentials`), so the credential is marked dead instead of retried. Anthropic subscription needed no change (Claude Code 2.1.280 and SDK 0.112.1 already match opencodex and oh-my-pi).
