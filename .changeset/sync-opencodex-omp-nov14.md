---
"server": minor
---

Sync subscription/OAuth providers with opencodex v2.100.2-156 (`43f97616c`) and oh-my-pi 18.20.0 (`8b1fd3233b`).

Kiro: native `output_config.effort` is now sent for Opus 4.8/4.7/4.6, Sonnet 5.5/5/4.6 and Haiku 5.5 (Opus/Sonnet 4.6 keep `xhigh` emulated, `minimal` stays emulated for these ids instead of being rejected); `ultra` is sent as `max` on native models. Tool and structured-output schemas keep the keywords Kiro was probed to accept for `claude-opus-4.5` (all) and `claude-opus-5.5`/`claude-sonnet-5.5` (`pattern`, `maximum`) and still strip them for every other id (opencodex `44efa741c`).

Antigravity: the CLI User-Agent gate also matches the `-xhigh` tier suffix on Gemini 4 wire ids (`gemini-4-<codename>-xhigh`, Hydrogen's top tier), which CCA 404s with the IDE agent (opencodex `7ae8f079b`, `585f048e8`).

ChatGPT subscription: user agent follows omp 18.20.0. Anthropic and Claude subscription: upstream changes since the last sync do not touch their wire behaviour.
