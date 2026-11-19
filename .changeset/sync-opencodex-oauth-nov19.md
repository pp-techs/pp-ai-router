---
"server": patch
---

Sync subscription providers with opencodex v2.100.3-129 (`fc0816c29`) and oh-my-pi 19.0.0 (`57771ae562`).

ChatGPT subscription: the user agent follows omp 19.0.0 (`omp/19.0.0`); the Codex client version, OAuth rules and `wham/usage` parsing (including the Business/Enterprise `spend_control` cap) were unchanged or already ported.

Kiro: `gpt-6.2-sol` and `gpt-6.2-astra` are listed ahead of Kiro's catalog, with native `reasoning` effort like GPT-6.1 Sol (opencodex `c320932c1`); requests for them fail upstream until Kiro ships them.

Claude subscription and Antigravity: no wire change. The four OAuth flows were re-verified and needed no change.
