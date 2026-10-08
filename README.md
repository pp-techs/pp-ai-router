# pp-ai-router

LLM/AI router: one OpenAI- and Anthropic-compatible endpoint in front of many upstream providers
(OpenAI-compatible APIs, Anthropic, and subscription/OAuth accounts such as Kiro and Google
Antigravity), with virtual keys, budgets, multi-credential load balancing and model pricing.

- [`apps/server`](apps/server/README.md): router + admin API (Node 24, Hono, SQLite)
- [`apps/web`](apps/web/README.md): admin UI (React, Vite, Tailwind)
- `packages/utils`: starter library

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
