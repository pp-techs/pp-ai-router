---
"server": minor
"web": minor
---

Custom upstream headers. A provider carries a `headers` map (JSON in the new `providers.headers`, `credentials.headers` columns) that every request to it sends — chat completions, the model-list fetch and the OAuth account-quota probe — and each credential carries its own map that overrides the provider's per name, so one API key can send a different value for a header than its siblings. The admin API validates both: names must be HTTP tokens, values single-line (at most 20 headers, 1000 characters each), and the headers that frame the request or the connection (`host`, `content-length`, hop-by-hop ones) are refused. An adapter applies the merge last, so a custom header can deliberately override one the adapter itself sets. Header values are stored unencrypted per provider/credential and never written to the audit log, only their names. The Add provider, Edit provider, Add API key and Edit credential dialogs edit them as name/value rows.

`PATCH /admin/providers/:id` no longer resets the fields a body leaves out: the request schema's defaults used to apply to a partial patch, so toggling a provider from the Providers page silently reset its `key_strategy`, `sticky_ttl_sec` and `max_key_attempts`.

Dialogs no longer let a form widen them past their max width: the shared dialog body is a single `minmax(0, 1fr)` column whose children may shrink, and the alias editor's target rows are `minmax(0, …)` tracks that stack on narrow screens instead of forcing the popup wider.
