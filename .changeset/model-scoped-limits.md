---
"server": minor
---

Per-model limits on API keys. A limit may carry a `model` glob (e.g. `openai/gpt-4o`, `claude-*`; null = every model) matched against the requested model: it only gates requests for matching models and counts only their usage, for any metric (USD, input/output/total tokens, requests) and window. Per-model usage is tracked in `usage_model_buckets` and seeded from the ledger on upgrade. The admin API and the 429 `limit_exceeded` error report the limit's `model`; the keys page can set it.
