---
"server": minor
"web": minor
---

Richer usage insights: the Overview shows eight headline stats (requests and cost compared with the previous 24 hours, 30-day projection, tokens, error rate, average latency, cache hit rate, cost per 1M tokens), and summary tables gain cache hit, error rate and average latency columns. `GET /admin/usage/summary` now returns cached and reasoning tokens, failed requests and average/max latency per group, and the usage endpoints accept `until`.
