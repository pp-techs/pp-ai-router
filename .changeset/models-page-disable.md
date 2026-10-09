---
"server": minor
"web": minor
---

Models page: `/models` now lists every model all providers offer (group by provider or one flat list, search by provider/id/name, filter enabled/disabled) with a switch to turn each model off; aliases moved to a `/models/aliases` tab. Server: new `disabled_models` table, `GET /admin/models` (all providers' stored lists) and `PATCH /admin/models/:provider/:model` `{enabled}`. A disabled model is not routed to (404 `model_not_found`, skipped inside aliases so fallbacks still work) and is hidden from `/v1/models`; an alias disappears there when all its targets are disabled. Provider model lists now carry an `enabled` flag.
