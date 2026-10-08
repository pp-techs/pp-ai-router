# web

Admin UI for the router: React 19, TypeScript, Tailwind CSS 4, TanStack Query, TanStack Router (file-based routes in `src/routes`), shadcn/ui (sidebar layout, Recharts charts).

```bash
vp run dev:server   # from the repo root: API on :8080 (needs MASTER_KEY and ADMIN_TOKEN)
vp run dev          # this app on :5173; /admin, /v1 and /healthz are proxied to 127.0.0.1:8080
vp build            # -> dist/, served by the server when WEB_DIST points at it
vp test             # unit tests (formatting, limit validation, API client)
```

Sign in with the server's `ADMIN_TOKEN`. It is kept in `sessionStorage` and sent as `Authorization: Bearer`; a 401 returns to the login screen.

- UI routes are plain paths (`/`, `/providers`, `/providers/:id`, `/models`, `/keys`, `/usage`, `/login`); global settings (pricing, appearance, account) open as a dialog through `?settings=<section>` on any page. Add a page by adding a file under `src/routes/_app/`; the dev server and `vp build` regenerate `src/route-tree.gen.ts`. The server falls back to `index.html` for any non-API GET, so never use `/admin…` or `/v1…` as a UI route.
- Provider types, including which ones offer an OAuth login and how their model list is known (`models`: static / fetch / none), come from `GET /admin/provider-types`; nothing about providers is hard-coded. A provider's Models card and the alias editor's model combobox read `GET /admin/providers/:id/models`.
- `src/api/` holds the typed client (`client.ts`), the fetch/auth core (`http.ts`), wire types and query keys; `src/pages/` is one folder per page.
