---
"server": patch
---

`UPSTREAM_TIMEOUT_MS` now defaults to 90s instead of 120s, and is a single deadline shared across every credential/target retry on one client-facing request instead of a fresh window per attempt. Previously a request that bounced through N credentials could hold a client connection open for up to N × 120s, and the default timeout matched Cloudflare's 100s "time to first byte" / 120s hard ceiling exactly, so slow upstreams surfaced as a bare Cloudflare 524 instead of a router-controlled error. Once the shared deadline passes, the router now stops retrying and returns `504 upstream_timeout` with a hint to use `stream: true` for long completions.
