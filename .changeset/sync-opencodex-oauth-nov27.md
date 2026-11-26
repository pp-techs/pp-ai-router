---
"server": patch
---

Sync subscription providers with opencodex v2.100.6-111 (`8ef15263e`) and oh-my-pi 19.2.1 (`b55cd1bb66`).

Claude subscription: a token refresh now follows Claude Code as oh-my-pi 19.2 mirrors it — `POST https://platform.claude.com/v1/oauth/token` with axios's default `Accept` / `User-Agent: axios/1.15.2` (no SDK identity or beta), Claude Code's scope set in the request (a grant that predates one of those scopes is retried once without `scope` after `invalid_scope`), and a login is retired only when the endpoint answers `invalid_grant` with HTTP 400/401, except `account_on_hold` (a held account can appeal). Any other failure — an outage, another error code, a bare 401, "refresh token expired" wording — keeps the login and only cools the account down, where before such text could retire it. The code exchange at sign-in is unchanged.

Antigravity: `gemini-4-neon` (and its tiers) now has the stock Claude Code phrases that make Cloud Code Assist answer a bare 429 stripped or reworded, as 3.7 and 3.8 Flash already did: the Claude Code / Agent SDK identity paragraphs and two reworded sentences (opencodex `414faafff`).

ChatGPT subscription: the user agent follows omp 19.2.1 (`omp/19.2.1`). Kiro: no wire change. The ChatGPT, Antigravity and Kiro OAuth rules were re-verified and needed no change.
