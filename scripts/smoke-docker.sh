#!/usr/bin/env bash
# Smoke test of the built image: `scripts/smoke-docker.sh <image>`.
# Starts the container with throwaway secrets, then requires /healthz, the served admin UI and the
# admin API (auth enforced) to answer. Used by CI and by the release workflow before publishing.
set -euo pipefail

image="${1:?usage: smoke-docker.sh <image>}"
name="pp-ai-router-smoke-$$"
port="${SMOKE_PORT:-18080}"
admin_token="smoke-admin-token-0123456789"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then docker logs "$name" 2>&1 | tail -50 || true; fi
  docker rm -f "$name" > /dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

docker run -d --name "$name" -p "127.0.0.1:$port:8080" \
  -e MASTER_KEY="$(head -c 32 /dev/urandom | base64)" \
  -e ADMIN_TOKEN="$admin_token" \
  "$image" > /dev/null

for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$port/healthz" > /dev/null 2>&1; then break; fi
  sleep 1
done

curl -fsS "http://127.0.0.1:$port/healthz" | grep -q '"ok":true'
curl -fsS "http://127.0.0.1:$port/" | grep -qi '<div id="root">'
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/admin/providers")" = "401" ]
curl -fsS -H "authorization: Bearer $admin_token" "http://127.0.0.1:$port/admin/providers" | grep -q '"data"'
echo "smoke ok: $image"
