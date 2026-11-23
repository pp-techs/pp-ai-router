---
"server": patch
---

Sync subscription providers with opencodex v2.100.6-52 (`9e0e298ef`) and oh-my-pi 19.1.0 (`a7135b8f31`).

ChatGPT subscription: the Codex session is identified by `session-id` alone — the legacy `session_id` and `conversation_id` headers are no longer sent, as in oh-my-pi 19.1.0 (`x-client-request-id` and the per-turn metadata are unchanged); the user agent follows omp 19.1.0 (`omp/19.1.0`).

Claude subscription, Antigravity and Kiro: no wire change. The four OAuth flows were re-verified and needed no change.
