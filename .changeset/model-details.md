---
"server": minor
"web": minor
---

Model lists now carry details: description, created, context window, max output tokens, input/output modalities and supported parameters, read from the upstream and filled in from OpenRouter's catalog where it is silent. Exposed on `GET /v1/models` (OpenRouter-style fields, `?verbose=1` for descriptions), the admin model lists (with `sources`), and the models page.
