# pp-ai-router

LLM/AI router: one OpenAI- and Anthropic-compatible endpoint in front of many upstream providers
(OpenAI-compatible APIs, Anthropic, and subscription/OAuth accounts such as Claude Pro/Max, Kiro and
Google Antigravity), with virtual keys, budgets, multi-credential load balancing and model pricing.

- [`apps/server`](apps/server/README.md): router + admin API (Node 24, Hono, SQLite)
- [`apps/web`](apps/web/README.md): admin UI (React, Vite, Tailwind)
- `packages/utils`: starter library

## Credits

The Anthropic (API key and Claude Pro/Max subscription), Kiro and Google Antigravity provider adapters (`apps/server/src/providers/`) are adapted from [lidge-jun/opencodex](https://github.com/lidge-jun/opencodex) (MIT), a local proxy for Codex and Claude Code. The router, key/budget governance, credential pool, pricing and admin UI are original to this project. See [what was ported](docs/project-pdr/opencodex-origin.md).

## Documentation

Start at [`docs/SUMMARY.md`](docs/SUMMARY.md): architecture, codebase map, code standards, product decisions.

## Develop

```bash
vp install
vp run ready          # check + test + build everything
vp run dev:server     # router on :8080 (needs MASTER_KEY and ADMIN_TOKEN, see apps/server/.env.example)
vp run dev            # admin UI on :5173, proxied to the router
```

## Deploy: one Docker image

The image contains the server and the built admin UI, served from the same port (UI at `/`, API at
`/v1/*` and `/admin/*`). State is a single SQLite file under `/data`.

```bash
cp apps/server/.env.example .env      # set MASTER_KEY (openssl rand -base64 32) and ADMIN_TOKEN
docker compose up -d --build          # or: docker build -t pp-ai-router . && docker run -p 8080:8080 -v router-data:/data --env-file .env pp-ai-router
```

Open `http://localhost:8080`, sign in with `ADMIN_TOKEN`, add a provider, credentials and a virtual key.
Back up the `/data` volume **and** keep `MASTER_KEY`: it decrypts every stored upstream secret.
Run a single replica (counters live in SQLite, pool state in memory). The container runs as a non-root user and has a health check on `/healthz`.

## CI and releases

GitHub Actions runs check, tests, build and a Docker smoke test on every PR. Releases use [changesets](https://github.com/changesets/changesets): add one with `bunx changeset`; merging the generated "Version Packages" PR builds, tests and publishes `ghcr.io/pp-techs/pp-ai-router:<version>` (and `latest`) and creates the GitHub Release. See [`docs/code-standard/release-process.md`](docs/code-standard/release-process.md).
