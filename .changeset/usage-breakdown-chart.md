---
"server": minor
"web": minor
---

Add a Breakdown chart to the Overview and Usage pages: cost, requests or tokens over time stacked by API key, provider or model, with a ranked share list. `GET /admin/usage/timeline` accepts `group_by=key|provider|model` and returns per-group buckets.
