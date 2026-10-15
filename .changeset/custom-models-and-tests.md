---
"server": minor
"web": minor
---

Custom models and model tests. Models page: "Add model" (toolbar or any provider group) creates a model by hand with every fact a listed model has (id, name, description, release date, context window, max output, input/output modalities, supported parameters); custom models are tagged, editable and deletable from the row menu, join the provider's list (so they survive refreshes, also on built-in lists) and are offered on `/v1/models`. Each row has "Test model" (and "Set price…"), each group and the toolbar have "Test all" (or "Test shown" while filtering) for the enabled models, run four at a time with progress and Stop, and a confirmation above ten; the last result (latency, or status and error) stays in a Test column. Server: `PUT|DELETE /admin/models/:provider/:model` for custom models (tables `custom_models`, `model_tests`), `POST /admin/model-tests {provider, model}` sends one tiny request through the provider's credentials without metering it or touching credential health, and the admin model lists carry `custom` and `last_test`.
