# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- `bun run version-packages` adds each release's section from its changesets; edit it in the Version Packages PR. -->

## [0.8.0] — 2026-10-10

Model lists now carry details: description, created, context window, max output tokens, input/output modalities and supported parameters, read from the upstream and filled in from OpenRouter's catalog where it is silent. Exposed on `GET /v1/models` (OpenRouter-style fields, `?verbose=1` for descriptions), the admin model lists (with `sources`), and the models page.

## [0.7.0] — 2026-10-10

Anthropic Subscription provider (`anthropic-subscription`), following opencodex: Claude models billed to a signed-in Claude Pro/Max account. Paste-flow PKCE sign-in and refresh, the Claude Code identity on every request (betas, headers, first system block, `custom_` tool-name wrapping), model discovery, and account quota (5-hour, weekly and per-model windows) that parks a spent account until it resets. The Messages translation is shared with the `anthropic` provider (`createAnthropicAdapter`).

## [0.6.0] — 2026-10-10

Add audit log and loggers feature for tracking administrative operations and gateway traffic events with dedicated audit log dashboard page.

## [0.5.0] — 2026-10-09

Models page: `/models` now lists every model all providers offer (group by provider or one flat list, search by provider/id/name, filter enabled/disabled) with a switch to turn each model off; aliases moved to a `/models/aliases` tab. Server: new `disabled_models` table, `GET /admin/models` (all providers' stored lists) and `PATCH /admin/models/:provider/:model` `{enabled}`. A disabled model is not routed to (404 `model_not_found`, skipped inside aliases so fallbacks still work) and is hidden from `/v1/models`; an alias disappears there when all its targets are disabled. Provider model lists now carry an `enabled` flag.

Server: price lookup now also tries other spellings of a model id when nothing matches exactly: `.` and `-` between version digits (`claude-sonnet-5.5` finds LiteLLM's `claude-sonnet-5-5`), a dropped `.0`, and the vendor prefix OpenRouter uses (`anthropic/…`, `openai/…`, `deepseek/deepseek-v3.2`). An exact id in any source still wins over a derived one, and overrides on the id as written win over both. Kiro's Claude 4.x/5.5 models and others that were billed as unpriced now get a price.

## [0.4.2] — 2026-10-08

Admin UI: select options show readable labels instead of raw ids (credential strategy "Round robin", limit windows "1 day", "Total", "Custom…", modes "Fixed (UTC)" / "Rolling"), and the select trigger is back to the plain Base UI `items` pattern. Server: Kiro model list adds `claude-sonnet-5.5` and `claude-opus-5.5` (1M context) and documents which announced ids are intentionally left out.

## [0.4.1] — 2026-10-08

Admin UI: scrollbars follow the app theme (light/dark toggle) instead of the OS preference and are thinner; select triggers always show the option label and never fall back to the raw value.

## [0.4.0] — 2026-10-08

Admin UI: migrate to TanStack Router with file-based routes, adopt the shadcn `sidebar-08` inset layout (collapsible sidebar, header breadcrumb, user menu), move global settings (pricing, appearance, account) into a `sidebar-13` settings dialog opened with `?settings=`, replace the flat per-row buttons in tables with a dropdown menu (API keys are now a table too), and add a usage chart (requests, tokens or cost over time) on the Usage and Overview pages. Server: `GET /admin/usage/timeline` returns usage bucketed by `bucket_ms`.

## [0.3.0] — 2026-10-08

Admin UI redesign following the Stitch design (shadcn base-nova, olive): a 240px sidebar with icons and a mobile nav sheet, breadcrumb page headers, status badges with a dot, empty states with icons and actions, a provider and alias filter, a totals row in the usage summary, and a restyled sign-in page.

## [0.2.0] — 2026-10-08

Account quota for OAuth providers (Kiro, Google Antigravity), following opencodex: `GET /admin/providers/:id/quota` and `GET /admin/credentials/:id/quota` report each account's remaining allowance (usage windows, Kiro credits, reset times), cached and re-read every `QUOTA_SYNC_INTERVAL_MINUTES` (default 30). An account whose allowance is spent is taken out of rotation until its quota resets, and a 429 from an OAuth account triggers a check so failover and parking happen immediately. The admin UI shows a Quota card on the provider page. The web unit tests now run in CI (`apps/web` gains a `test` script).

## [0.1.0] — 2026-10-08

Initial release: OpenAI- and Anthropic-compatible router with virtual keys, budgets, multi-credential pooling and model pricing; Anthropic, Kiro and Google Antigravity providers (adapted from [lidge-jun/opencodex](https://github.com/lidge-jun/opencodex)); admin UI and single-image Docker deployment.
