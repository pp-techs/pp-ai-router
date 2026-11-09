---
"server": minor
"web": minor
---

Usage dashboard: one filter bar now narrows the activity chart, summary and ledger together — API key, provider, status, streamed/buffered, unpriced, a model-name search and the time range. The chart gains a Failures metric, and the ledger follows the selected range instead of always showing all time.

The admin usage endpoints share those filters: `q` (requested or upstream model substring), `status` (one value or a comma list), `stream`, `unpriced` and `since` on `/admin/usage`, `/admin/usage/summary` and `/admin/usage/timeline`, and timeline buckets now include `failed_requests`.
