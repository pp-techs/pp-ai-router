# opencodex origin

Part of the provider layer is **adapted from [lidge-jun/opencodex](https://github.com/lidge-jun/opencodex)** (MIT licence). This page records what that project is, what was taken, what was left behind, and the rules for keeping the attribution correct.

## What opencodex is

Per its own README: a "universal provider proxy for OpenAI Codex & Claude Code". It is a local, single-user proxy (`ocx start`, dashboard on `localhost:10100`) that translates Codex's **Responses API** into whatever an upstream provider speaks, so Codex, Claude Code, Claude Desktop and Grok Build can run any LLM. It also manages a ChatGPT account pool for Codex auth. It is a CLI/desktop tool, not a hosted gateway.

## How pp-ai-router relates

|                 | opencodex                                 | pp-ai-router                                                                   |
| --------------- | ----------------------------------------- | ------------------------------------------------------------------------------ |
| Deployment      | Local proxy / desktop app for one user    | Self-hosted server (one Docker image, SQLite) for many clients                 |
| Client protocol | Codex Responses API (plus Claude Code)    | OpenAI `POST /v1/chat/completions` and Anthropic `POST /v1/messages`           |
| Client identity | The local user                            | Virtual keys (`sk-pp-…`) with limits and budgets                               |
| Upstream auth   | Local accounts, local `kiro-cli` database | Credentials pool per provider, encrypted with `MASTER_KEY`, admin-driven OAuth |
| Reused from it  | The upstream wire knowledge (below)       | Provider adapters that translate canonical chat-completions to each upstream   |

pp-ai-router is **not** a fork: the router, governance, pool, pricing, admin API and admin UI are original. Only the per-provider protocol translation was ported.

## What was adapted

Every adapted file starts with `// Adapted from lidge-jun/opencodex (MIT)` (28 files under `apps/server/src/providers/`). The port target is the canonical OpenAI chat-completions shape used by `ProviderAdapter` (`providers/adapter.ts`), instead of opencodex's Responses-API front end.

| Provider      | Adapted files                                                                                                         | Reference behaviour kept                                                                                                                    |
| ------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `anthropic`   | `anthropic.ts`, `anthropic/{model-contract,request,response}.ts`                                                      | Messages API translation, thinking/adaptive effort rules, signed `thinking_blocks`, history repair                                          |
| `antigravity` | `antigravity/{adapter,constants,models,oauth,quota,replay,request,stream,tool-schema,wire-compiler}.ts`               | Cloud Code Assist `v1internal` wire format, model-name mapping, tool-schema reduction, thought-signature replay, PKCE paste login           |
| `kiro`        | `kiro/{adapter,errors,events,eventstream,models,oauth,quota,reasoning,request,stream,think-tags,tools,usage,wire}.ts` | CodeWhisperer streaming request/response mapping, AWS event-stream decoding, SSO OIDC device login, region fallback, token-usage heuristics |

Quota (`kiro/quota.ts` from `src/providers/kiro-usage.ts`, `antigravity/quota.ts` from `src/providers/quota/antigravity.ts`) ports only the upstream calls and response parsing. The service around it (`src/quota/`: cache, parking in the pool, admin API, UI) is original.

Not adapted (original to this repo): `quota/`, `providers/openai-compat.ts`, `providers/chunks.ts`, `providers/model-list.ts`, `providers/anthropic/json.ts`, `providers/antigravity/json.ts`.

## What was deliberately not ported

These exist in opencodex for its Codex/Responses front end or local-machine integration (details in `apps/server/README.md`, section Kiro):

- the private "final answer" completion tool and text-fallback retry
- Responses continuations and reasoning-blob replay (`signature` / `redactedContent` are dropped)
- per-conversation token calibration and image re-encoding
- the process-wide 429 throttle gate and connection-reset retries (the gateway's failover covers them)
- reading or rotating the local `kiro-cli` database, account leases/failover, quota-based routing rank, on-disk quota verdicts, passive quota observation, the pinned outbound transport for quota probes

## Rules for contributors

- **Keep the header.** New files derived from opencodex code get `// Adapted from lidge-jun/opencodex (MIT)`; a file ported from a specific reference path may add it (`kiro/models.ts` does: `src/providers/kiro-models.ts`). Do not strip it when refactoring an adapted file.
- **Diverge on purpose, document it.** When behaviour differs from the reference, say so in the provider's section of `apps/server/README.md` ("Not ported" / "like the reference").
- **Reference quirks are contract.** Model-name mappings, constants and heuristics (Kiro token estimates, Antigravity model ids) follow the reference; check upstream opencodex before "fixing" them, because they mimic undocumented vendor clients.
- **Licence.** opencodex is MIT. The repo currently has no `LICENSE` or `NOTICE` file; the per-file header is the only attribution besides the READMEs. [TBD: confirm with the maintainers whether a `NOTICE` with the upstream copyright line should be added.]
- **Not official APIs.** Kiro and Antigravity adapters mimic vendor clients; the vendors can change or block them at any time (stated in `apps/server/README.md`).
