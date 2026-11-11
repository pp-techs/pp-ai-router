---
"server": minor
---

Sync subscription providers with opencodex v2.100.0-61 (`aaca968d7`) and oh-my-pi 18.18.8 (`679691a781`).

Claude subscription: a `claude_code_version_too_old` rejection is now judged against the Claude Code version the failed request actually presented, and the adopted minimum only ever moves forward. Concurrent first requests all sent the stale pin, so before this only the first retried and the rest failed (oh-my-pi `679691a781`).

Claude subscription quota: a usage payload that positively declares a shared window inactive — `five_hour: null` with no `session` row in `limits[]`, or `seven_day: null` with no `weekly_all` row — now counts as a complete reading, so a model-scope 429 cooldown can be lifted while that window is not running. A missing bucket field or a payload without `limits[]` still proves nothing (oh-my-pi `679691a781`).

Antigravity: every Gemini 4 codename wire id, bare or with a `-low`/`-medium`/`-high` suffix, is now sent with the Antigravity CLI User-Agent, because Cloud Code Assist answers 404 to the IDE User-Agent for those (Argon verified 2026-10-14, Carbon 2026-11-11). `gemini-4-carbon` and its three tiers are listed, mirroring Argon's mapping; only Argon keeps the extra `thinkingConfig.thinkingLevel` needed for its thought summaries (opencodex `5197322e2`).
