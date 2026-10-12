---
"server": minor
---

Subscription/OAuth providers synced with opencodex v2.83.0. Anthropic and Anthropic Subscription: Haiku 5.5 / Sonnet 5.5 model contracts, thinking-off handling per model, `response_format: json_schema` as `output_config.format`, `reasoning_tokens`, `refusal`/`error` stop reasons, more terminal refresh errors. Antigravity: one replay of a 400 that blames tool schemas or thinking config, model context windows and input modalities. Kiro: usage probe region from the profile ARN, per-minute rate limits no longer treated as spent quota, 400 expired-token mapped to 401, image token estimate from dimensions.
