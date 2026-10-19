---
"server": minor
---

Sync subscription/OAuth providers with opencodex v2.83.0-220 (`6936d9885`). Antigravity: when a Gemini model replays an assistant turn that made tool calls, only the first sentence of its pre-call progress text is sent back to Google, so leaked planning text no longer compounds through the history (Claude and gpt-oss models and the client-facing response are unchanged). Kiro and Anthropic subscription needed no code change; the Anthropic README now records which upstream Responses-lane fixes are deliberately not ported.
