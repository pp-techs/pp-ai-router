# Conventions

## Toolchain (Vite+)

Everything goes through the `vp` CLI; see `AGENTS.md`. `vp install`, `vp check` (format, lint, type check), `vp test`, `vp run <script>`. Root scripts: `ready` (check + tests + builds), `dev` (admin UI), `dev:server`. Import test/build helpers from `vite-plus`, not `vite`/`vitest` (lint rule `vite-plus/prefer-vite-plus-imports`). Formatting and linting use Oxc (Oxfmt/Oxlint, type-aware); the pre-commit hook runs `vp staged` (`vp check --fix`). Package manager: bun (`devEngines`). Node: `.node-version` 24.21.0; server needs Node >= 24.

## TypeScript

- Strict config in `apps/server/tsconfig.json`: `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `noUnused*`, `allowImportingTsExtensions`.
- The server runs `.ts` directly via Node type stripping: **no enums, namespaces or parameter properties**; use `import type` for types; import local files **with the `.ts` extension**.
- Private state uses `#fields`; classes take dependencies through the constructor (see `Registry`, `CredentialPool`, `Accounting`).
- Time is injected (`now: () => number`) so tests are deterministic; do not call `Date.now()` in logic that tests need to control.
- Validate external input with Zod (`config.ts`, request schemas); reject at the boundary.

## Server patterns

- **Wiring** only in `createServices` (`app.ts`); modules do not import each other's singletons.
- **Errors**: throw `HttpError(status, code, message, extra?)`; the envelope is OpenAI-style `{ error: { message, type, code } }`. Anthropic-format errors only on `/v1/messages`.
- **Provider adapters** return OpenAI-shaped `Response`s, pass non-2xx upstream responses through unchanged, throw only on transport errors, and never echo secrets in errors or logs. Register new types in `ADAPTERS`; the admin UI reads them from `GET /admin/provider-types`, so nothing about providers is hard-coded in the UI.
- **Adapted code**: files derived from opencodex keep the line-1 attribution header; document divergences in `apps/server/README.md` ([../project-pdr/opencodex-origin.md](../project-pdr/opencodex-origin.md)).
- **SQL**: prepared statements with `one`/`all` helpers, `transaction()` for multi-statement writes, `STRICT` tables, schema changes as a new numbered migration (never edit an applied one).
- **Comments** explain why (constraints, upstream quirks), usually as `/** */` on exports; names are descriptive, files are kebab-case (`login-sessions.ts`).
- Tokens/secrets: never log or return them; virtual keys only as a hash.

## Web patterns

- React 19 + TypeScript, Tailwind 4, Base UI / shadcn components in `components/ui/`, `lucide-react` icons, `@buiducnhat/better-modal` for dialogs.
- Server state through TanStack Query: keys live in `qk` (`api/queries.ts`, hierarchical); mutations use `useAction` (invalidate keys, toast outcome, `inline` when a dialog shows the error).
- API access only via `api/client.ts` over `api/http.ts`; the admin token stays in `sessionStorage`; a 401 returns to login and clears the query cache.
- Logic that can be tested without React goes in `lib/` with a colocated `*.test.ts`.
- Page-specific components live next to their page (`pages/<page>/…`); `@` aliases `src/`.

## Docs

Per-provider behaviour is documented in `apps/server/README.md`; package READMEs stay next to the code; cross-cutting docs live in `docs/` (indexed in `SUMMARY.md`).
