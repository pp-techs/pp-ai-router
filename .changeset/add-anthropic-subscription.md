---
"server": minor
"web": minor
---

Anthropic Subscription provider (`anthropic-subscription`), following opencodex: Claude models billed to a signed-in Claude Pro/Max account. Paste-flow PKCE sign-in and refresh, the Claude Code identity on every request (betas, headers, first system block, `custom_` tool-name wrapping), model discovery, and account quota (5-hour, weekly and per-model windows) that parks a spent account until it resets. The Messages translation is shared with the `anthropic` provider (`createAnthropicAdapter`).
