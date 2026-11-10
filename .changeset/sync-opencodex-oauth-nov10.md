---
"server": minor
---

Sync subscription/OAuth providers with opencodex v2.100.0 (`0d691be83`) and oh-my-pi 18.18.6 (`9058ab9d2`).

Anthropic and Claude subscription: the Claude Code identity moves to the CLI 2.1.321 / SDK 0.128.0 fingerprint (`X-Stainless-Runtime-Version` v26.12.1), `mid-conversation-system-2026-04-07` is dropped from the agent, account and model-discovery betas because the mid-conversation system role is generally available, and the model contract learns the Mythos family (adaptive thinking, no sampling parameters, no thinking-off switch, no forced tool choice from 5) so `claude-mythos-5…` gets the same narrowed wire shape as Fable (oh-my-pi `9058ab9d2`; opencodex's automatic cache boundary, the `thinkingDisplay` knob and Claude CLI quota observation are not ported).

Antigravity: a real HTTP 400 from Cloud Code Assist now drops the session's replayed thought signatures, so a rejected signature is not resent until its TTL expires; Gemini 4 Argon requests that ask for thought summaries repeat the suffix tier in `thinkingConfig.thinkingLevel`, without which the backend answers 200 with no thought parts (opencodex `1d16d7932`, `3b23d46e7`).

ChatGPT subscription: a tool whose Chat request omitted `strict` is sent with `strict: false`, because the Responses wire reads an omitted flag as strict and would turn optional arguments into required ones; the `omp/18.18.6` user agent follows the reference (opencodex `036d0b201`).

Kiro: `response_format` `json_schema` / `json_object` is emulated through a private terminal tool instead of being refused — the caller still receives parsed JSON or an error, never prose, with whole-schema validation when `strict: true` and a pre-flight 400 for a strict schema the emulation cannot enforce; supplementary Han characters count as their two UTF-16 units in the token estimate; the model list gains the reference's preemptive GPT-6 / GPT-6.1 ids (opencodex `cd8d26d43`, `e5c9e3fc2`).

The four OAuth flows were re-verified at both upstreams and needed no change: client ids, scopes, endpoints, redirects, PKCE/state, token bodies, expiry skew and refresh-failure classification still match.
