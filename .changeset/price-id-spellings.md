---
"server": patch
"web": patch
---

Server: price lookup now also tries other spellings of a model id when nothing matches exactly: `.` and `-` between version digits (`claude-sonnet-5.5` finds LiteLLM's `claude-sonnet-5-5`), a dropped `.0`, and the vendor prefix OpenRouter uses (`anthropic/…`, `openai/…`, `deepseek/deepseek-v3.2`). An exact id in any source still wins over a derived one, and overrides on the id as written win over both. Kiro's Claude 4.x/5.5 models and others that were billed as unpriced now get a price.
