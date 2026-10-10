# Testing

Runner: `vp test` (Vitest through Vite+); import `describe`/`it`/`expect` from `vite-plus/test`. `vp run ready` at the repo root runs check + all tests + builds.

## Server (`apps/server/tests/`)

- **Harness** (`tests/harness.ts`): `createHarness()` builds the real app with an in-memory SQLite DB, a controllable clock (`clock.now`) and helpers (`admin`, `chat`, `addProvider`, `newKey`). Prefer it over mocking internals.
- **Stand-in upstreams**: `startUpstream(handler)` is a real HTTP server on an ephemeral port that records the secret and body the router sent. Use it for gateway behaviour (failover, cooldown, limits, streaming usage).
- **Fake adapters**: `createServices(..., { adapters })` / harness option `adapters` plugs in fake `ProviderAdapter`s.
- **Provider adapters** have their own files (`anthropic`, `anthropic-subscription`, `antigravity`, `kiro`) testing request mapping, stream decoding, OAuth and refresh against injected `fetch`/servers; shared SSE helpers come from `providers/chunks.ts`.
- One file per area: `gateway`, `limits`, `models`, `oauth`, `pricing`, `selectors`, `chunks`, `web` (static UI serving).
- When changing an adapted opencodex adapter, keep its test file in step and cover the divergence from the reference.

## Web (`apps/web/src/**/*.test.ts`)

Only non-React logic is tested (`api/http.test.ts`, `lib/*.test.ts`), colocated with the source. Component behaviour is verified manually in the running UI (`vp run dev:server` + `vp run dev`).

## Rules

- Deterministic and isolated: no network, no real clock, no shared DB state.
- Assert consumer-visible behaviour (status codes, headers, error envelopes, accounting rows), not implementation wiring.
