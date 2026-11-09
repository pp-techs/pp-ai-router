---
"server": patch
---

Sync the OAuth flows with opencodex v2.99.0 (`667662903`) and oh-my-pi `21f1188cf8` (18.18.3).

Antigravity: a token is now treated as expired five minutes before Google says, at login and on refresh, as both references do (opencodex `REFRESH_SKEW_MS`, oh-my-pi `skew-ms=300000`). The account refreshes before the bearer's last five minutes instead of its last one.

Claude subscription, ChatGPT subscription and Kiro needed no change: client ids, scopes, endpoints, redirects, PKCE/state, token bodies, expiry skew, identity claims and refresh-failure classification still match their oh-my-pi rules (Claude, ChatGPT) or opencodex (Kiro). opencodex's OAuth commits since `cab7eb7d0` are credential-store locking, pool routing and public error mapping, which this gateway does not port; oh-my-pi changed no OAuth flow file. The adapter wire behaviour was not re-synced, so the recorded sync base is unchanged.
