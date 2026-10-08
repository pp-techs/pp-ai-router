# Directory structure

Bun/Vite+ workspace (`package.json` workspaces: `packages/*`, `apps/*`, `tools/*`; there is no `tools/` yet).

```
pp-ai-router/
├── apps/
│   ├── server/            router + admin API (Node 24, Hono, node:sqlite, Zod)
│   │   ├── src/           see "Server modules" below
│   │   ├── tests/         vitest (via vp test), real HTTP stand-in upstreams
│   │   └── .env.example
│   └── web/               admin UI (React 19, Vite, Tailwind 4)
│       └── src/
├── packages/utils/        starter library (tsdown), not used by the apps
├── .github/               workflows (ci.yml, release.yml), dependabot, CODEOWNERS, PR template
├── .changeset/            pending changesets + config (server and web release in lockstep)
├── scripts/               version-packages.ts (release version step), smoke-docker.sh (image smoke test)
├── CHANGELOG.md           root changelog; one section per release, written by version-packages
├── Dockerfile, compose.yaml   single-image deployment
├── vite.config.ts         Vite+ config: staged hook, lint (type-aware), task cache
├── .vite-hooks/pre-commit runs `vp staged`
├── .node-version          24.21.0 (also what the Docker build ships)
└── docs/                  this documentation
```

## Entry points

| Entry                               | Purpose                                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------------------- |
| `apps/server/src/main.ts`           | Process entry: config, services, schedulers, HTTP server, shutdown                       |
| `apps/server/src/app.ts`            | `createServices(config, options)`: wires all modules into a Hono app (used by tests too) |
| `apps/web/src/main.tsx` / `app.tsx` | UI bootstrap and routes                                                                  |

## Server modules (`apps/server/src/`)

| Path                          | Responsibility                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `config.ts`                   | Zod-validated env                                                                                             |
| `errors.ts`                   | `HttpError`, OpenAI-style `errorBody`                                                                         |
| `crypto.ts`, `credentials.ts` | `SecretBox` AES-256-GCM; seal/open credential auth                                                            |
| `db/`                         | `database.ts` (open, `transaction`, `one`, `all`), `migrate.ts`, `migrations/*.sql`                           |
| `registry.ts`                 | In-memory providers/credentials/aliases snapshot, alias/`provider/model` resolution                           |
| `pool/`                       | `pool.ts` leases and cooldowns, `selectors.ts` strategies, `recent-usage.ts`                                  |
| `gateway/`                    | `chat.ts` shared pipeline + `/v1/chat/completions`, `messages.ts` `/v1/messages`, `accounting.ts`, `usage.ts` |
| `governance/`                 | `virtual-keys.ts` (keys, model globs), `limits.ts` (`UsageMeter`, windows)                                    |
| `pricing/`                    | `store.ts`, `cost.ts`, `sync.ts`, `litellm.ts`, `openrouter.ts`, `types.ts`                                   |
| `oauth/`                      | `types.ts`, `login-sessions.ts`, `token-manager.ts`                                                           |
| `models.ts`                   | `ModelCatalog` stored model lists + sync scheduler                                                            |
| `quota/`                      | `service.ts` (`QuotaService`: cache, probes, pool parking, sync), `types.ts`, `wire.ts` (parsing helpers)     |
| `admin/routes.ts`             | `/admin/*` API behind `ADMIN_TOKEN`                                                                           |
| `providers/`                  | Adapters (see below)                                                                                          |
| `glob.ts`, `logger.ts`        | Glob matching for model patterns, structured logger                                                           |

### `providers/`

| Path                                             | Notes                                                                |
| ------------------------------------------------ | -------------------------------------------------------------------- |
| `adapter.ts`                                     | `ProviderAdapter` contract and `ADAPTERS` registry                   |
| `openai-compat.ts`, `chunks.ts`, `model-list.ts` | Original: generic upstream, OpenAI chunk helpers, model-list parsing |
| `anthropic.ts`, `anthropic/`                     | **From opencodex**, except `json.ts`                                 |
| `antigravity/`                                   | **From opencodex**, except `json.ts`                                 |
| `kiro/`                                          | **From opencodex** (all files)                                       |

Files adapted from [lidge-jun/opencodex](https://github.com/lidge-jun/opencodex) carry `// Adapted from lidge-jun/opencodex (MIT)` on line 1. Details: [../project-pdr/opencodex-origin.md](../project-pdr/opencodex-origin.md).

## Web app (`apps/web/src/`)

| Path              | Responsibility                                                                                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api/`            | `http.ts` fetch/auth core (ky, token in `sessionStorage`), `client.ts` typed endpoints, `queries.ts` query keys + `useAction`, `types.ts` wire types                                               |
| `routes/`         | TanStack Router file routes: `__root`, `login`, and `_app` (auth guard + sidebar layout) with its pages as children. `route-tree.gen.ts` is generated by the Vite plugin; commit it                |
| `pages/`          | Page bodies the routes render: `overview`, `providers/`, `aliases` (route `/models`), `keys/`, `usage/` (incl. the chart), `pricing/` (shown in Settings), `login`, `not-found`                    |
| `components/`     | `app-layout` (shadcn sidebar-08 shell), `app-sidebar`, `row-actions` (dropdown for a table row), `settings/` (sidebar-13 settings dialog), `page`, ...; `components/ui/` shadcn/Base UI primitives |
| `lib/`            | Pure helpers with colocated `*.test.ts` (format, limits, models, credential health)                                                                                                                |
| `query-client.ts` | TanStack Query defaults, global mutation error toast, cache clear on sign-out                                                                                                                      |

Routes: `/`, `/providers`, `/providers/$id`, `/models`, `/keys`, `/usage`, `/login`. Settings (pricing, appearance, account) is a dialog opened by `?settings=pricing|appearance|account` on any page. Never use `/admin…` or `/v1…` as a UI route (the server falls back to `index.html` for other GETs).
