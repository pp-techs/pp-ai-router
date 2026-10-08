# syntax=docker/dockerfile:1
#
# One image: the Node.js server (API + gateway) serving the built admin UI on the same port.
#   docker build -t pp-ai-router .
#   docker run -p 8080:8080 -v router-data:/data -e MASTER_KEY=... -e ADMIN_TOKEN=... pp-ai-router

# --- manifests: only package.json / lockfile / .node-version, so dependency layers cache across source edits ---
FROM busybox:stable AS manifests
COPY . /src
RUN find /src -type f ! -name package.json ! -name bun.lock ! -name '.node-version' -delete

# --- build: Vite+ toolchain image; builds the admin UI and exports the exact Node.js from .node-version ---
FROM ghcr.io/voidzero-dev/vite-plus:latest AS build
WORKDIR /app
COPY --from=manifests --chown=vp:vp /src ./
RUN vp install --frozen-lockfile --ignore-scripts
COPY --chown=vp:vp . .
RUN vp run web#build
RUN cp "$(vp env which node | head -1)" /tmp/node

# --- deps: production-only dependencies of the server (a fresh install, so no devDependencies/toolchain leak in) ---
FROM ghcr.io/voidzero-dev/vite-plus:latest AS deps
WORKDIR /app
COPY --from=manifests --chown=vp:vp /src ./
RUN vp install --frozen-lockfile --ignore-scripts --prod --filter server

# --- runtime: glibc, no toolchain. Node 24 runs the TypeScript sources directly (type stripping). ---
FROM debian:bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DB_PATH=/data/router.db \
    WEB_DIST=/app/web
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin router \
 && mkdir /data && chown router:router /data
WORKDIR /app
COPY --from=build /tmp/node /usr/local/bin/node
# bun installs the real packages under node_modules/.bun and links them from apps/server/node_modules.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/src ./apps/server/src
COPY --from=build /app/apps/web/dist ./web
USER router
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
WORKDIR /app/apps/server
CMD ["node", "src/main.ts"]
