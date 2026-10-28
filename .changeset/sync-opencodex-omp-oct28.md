---
"server": minor
---

ChatGPT subscription: a rate-limit 429 now takes its retry hint only from `error.resets_at` or a header window that is exhausted, not from a plan window that still has headroom; credit-billed seats are read from `spend_control.individual_limit` as a `Spend cap` window (no credit overage when the cap shows no headroom); array tool schemas without `items` get `items: true`; user agent follows omp 18.13.2; `gpt-6.1-terra` is listed (oh-my-pi `58da9df47f`, `d698106d95`, `9810521fa9`, `2ff15b2c21`, `b1ef4170c8`, `e00ec482ef`).

Antigravity: the `aicode` OAuth scope is requested, and in-band stream error frames keep their status and details in the error message (oh-my-pi `917a365890`, `e2f9f9b914`).

Kiro: `OVERAGE_REQUEST_LIMIT_EXCEEDED` is mapped to 429 `insufficient_quota` like `MONTHLY_REQUEST_COUNT`; `gpt-6.1-terra` gets the native reasoning effort field (opencodex `5ab431bec`, `2606f6f92`). Anthropic and Claude subscription: upstream changes since the last sync do not touch their wire behaviour.
