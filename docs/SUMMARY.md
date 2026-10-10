# Documentation Summary

pp-ai-router — a self-hosted LLM router: one OpenAI- and Anthropic-compatible endpoint in front of many upstream providers, with virtual keys, budgets, credential pooling and pricing. Provider adapters for Anthropic (API key and Claude subscription), Kiro and Google Antigravity are adapted from [opencodex](https://github.com/lidge-jun/opencodex) (MIT).
Stack: Node 24, Hono, `node:sqlite`, Zod (server); React 19, Vite, Tailwind 4, TanStack Query (admin UI); Vite+ (`vp`) toolchain, bun, Docker.

## Agent Context Guide

Before planning or implementing, read this `docs/SUMMARY.md` file first. Load only the detail docs relevant to the current task, and prioritize `Code Standard` docs for implementation conventions. If docs conflict with code or user intent, use the available question tool before making broad changes.

## Architecture

System design, component interactions, data flows, deployment, and external integrations.

| File                                                          | Description                                                                      |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [request-pipeline.md](architecture/request-pipeline.md)       | Auth, limits, routing, credential selection, failover and accounting per request |
| [provider-adapters.md](architecture/provider-adapters.md)     | Adapter contract, provider types, registry/pool, OAuth login and refresh, models |
| [data-and-deployment.md](architecture/data-and-deployment.md) | SQLite schema, accounting, pricing, process model, Docker deployment, config     |

## Codebase

Directory structure, entry points, API patterns, and key modules.

| File                                                      | Description                                                                             |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [directory-structure.md](codebase/directory-structure.md) | Workspace layout, entry points, server and web modules, which files come from opencodex |

## Code Standard

Conventions, naming rules, tech stack versions, and development workflows.

| File                                                   | Description                                                                |
| ------------------------------------------------------ | -------------------------------------------------------------------------- |
| [conventions.md](code-standard/conventions.md)         | Vite+ toolchain, TypeScript rules, server/web patterns, attribution header |
| [testing.md](code-standard/testing.md)                 | Test runner, server harness and stand-in upstreams, web test scope         |
| [release-process.md](code-standard/release-process.md) | CI jobs, changesets, Version Packages PR, Docker image release to GHCR     |

## Project PDR

Product goals, use cases, business rules, and constraints.

| File                                                   | Description                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| [product-goals.md](project-pdr/product-goals.md)       | Goals, use cases, enforced business rules and constraints                      |
| [opencodex-origin.md](project-pdr/opencodex-origin.md) | The original opencodex project, what was adapted/not ported, attribution rules |

## Other

Per-package READMEs next to the code.

| File                                              | Description                                                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [apps/server/README.md](../apps/server/README.md) | Concepts, API, per-provider (Anthropic, Anthropic Subscription, Antigravity, Kiro) behaviour and ported-from notes |
| [apps/web/README.md](../apps/web/README.md)       | Admin UI dev workflow and conventions                                                                              |
