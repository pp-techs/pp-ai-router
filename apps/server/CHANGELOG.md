# server

## 0.4.2

### Patch Changes

- 1925772: Admin UI: select options show readable labels instead of raw ids (credential strategy "Round robin", limit windows "1 day", "Total", "Custom…", modes "Fixed (UTC)" / "Rolling"), and the select trigger is back to the plain Base UI `items` pattern. Server: Kiro model list adds `claude-sonnet-5.5` and `claude-opus-5.5` (1M context) and documents which announced ids are intentionally left out.

## 0.4.1

### Patch Changes

- 97ff8c1: Admin UI: scrollbars follow the app theme (light/dark toggle) instead of the OS preference and are thinner; select triggers always show the option label and never fall back to the raw value.

## 0.4.0

### Minor Changes

- 6a8b9a3: Admin UI: migrate to TanStack Router with file-based routes, adopt the shadcn `sidebar-08` inset layout (collapsible sidebar, header breadcrumb, user menu), move global settings (pricing, appearance, account) into a `sidebar-13` settings dialog opened with `?settings=`, replace the flat per-row buttons in tables with a dropdown menu (API keys are now a table too), and add a usage chart (requests, tokens or cost over time) on the Usage and Overview pages. Server: `GET /admin/usage/timeline` returns usage bucketed by `bucket_ms`.

## 0.3.0

No changes in this release.

## 0.2.0

### Minor Changes

- c1e1f3b: Account quota for OAuth providers (Kiro, Google Antigravity), following opencodex: `GET /admin/providers/:id/quota` and `GET /admin/credentials/:id/quota` report each account's remaining allowance (usage windows, Kiro credits, reset times), cached and re-read every `QUOTA_SYNC_INTERVAL_MINUTES` (default 30). An account whose allowance is spent is taken out of rotation until its quota resets, and a 429 from an OAuth account triggers a check so failover and parking happen immediately. The admin UI shows a Quota card on the provider page. The web unit tests now run in CI (`apps/web` gains a `test` script).

## 0.1.0

### Minor Changes

- 89c95f7: Initial release: OpenAI- and Anthropic-compatible router with virtual keys, budgets, multi-credential pooling and model pricing; Anthropic, Kiro and Google Antigravity providers (adapted from [lidge-jun/opencodex](https://github.com/lidge-jun/opencodex)); admin UI and single-image Docker deployment.
