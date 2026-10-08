# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- `bun run version-packages` adds each release's section from its changesets; edit it in the Version Packages PR. -->

## [0.3.0] — 2026-10-08

Admin UI redesign following the Stitch design (shadcn base-nova, olive): a 240px sidebar with icons and a mobile nav sheet, breadcrumb page headers, status badges with a dot, empty states with icons and actions, a provider and alias filter, a totals row in the usage summary, and a restyled sign-in page.

## [0.2.0] — 2026-10-08

Account quota for OAuth providers (Kiro, Google Antigravity), following opencodex: `GET /admin/providers/:id/quota` and `GET /admin/credentials/:id/quota` report each account's remaining allowance (usage windows, Kiro credits, reset times), cached and re-read every `QUOTA_SYNC_INTERVAL_MINUTES` (default 30). An account whose allowance is spent is taken out of rotation until its quota resets, and a 429 from an OAuth account triggers a check so failover and parking happen immediately. The admin UI shows a Quota card on the provider page. The web unit tests now run in CI (`apps/web` gains a `test` script).

## [0.1.0] — 2026-10-08

Initial release: OpenAI- and Anthropic-compatible router with virtual keys, budgets, multi-credential pooling and model pricing; Anthropic, Kiro and Google Antigravity providers (adapted from [lidge-jun/opencodex](https://github.com/lidge-jun/opencodex)); admin UI and single-image Docker deployment.
