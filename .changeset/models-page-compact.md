---
"server": minor
"web": minor
---

Models page: rows are one line (no description or release date; modalities and the parameter count are tags in their own column), provider groups collapse (with Collapse all / Expand all), and each group has Disable all / Enable all to switch a whole provider's list at once, e.g. everything on OpenRouter except a few models. With a search or status filter on, the buttons act on the models shown. Server: `PATCH /admin/models/:provider` `{enabled, models?}` switches many models in one call (`models` omitted = every model the provider lists).
