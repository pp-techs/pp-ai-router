# Product goals and business rules

pp-ai-router is a self-hosted LLM/AI router: one OpenAI- and Anthropic-compatible endpoint in front of many upstream providers, with per-client virtual keys, budgets, multi-credential load balancing and model pricing. Facts below come from the code and READMEs; no business requirements beyond them are assumed.

## Goals

- One stable client endpoint (`/v1/chat/completions`, `/v1/messages`, `/v1/models`) regardless of upstream.
- Upstream types: OpenAI-compatible APIs, Anthropic, and subscription/OAuth accounts (Kiro, Google Antigravity). The OAuth adapters are adapted from opencodex: see [opencodex-origin.md](opencodex-origin.md).
- Spread load over many credentials per provider and survive upstream failures (cooldown, retry on another credential, alias fallback targets).
- Hand out virtual keys with usage limits and measure cost per request.
- Operate it from an admin UI/API; run as a single Docker container with one SQLite file.

## Use cases

| Use case                         | How it is served                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Give a teammate/app a capped key | `POST /admin/keys` with `limits` (`usd`, token or request metrics over a window), optional `allowed_models`, expiry |
| Pool several API keys            | One provider, many credentials, `key_strategy` + optional sticky sessions                                           |
| Use Claude Code / Anthropic SDK  | Point `ANTHROPIC_BASE_URL` at the router; `/v1/messages` works against any provider type                            |
| Use a subscription account       | Admin signs in through the OAuth flow (Kiro device flow, Antigravity paste flow); tokens refresh automatically      |
| Stable model names               | Aliases map a public name to an ordered list of `{provider, model}` fallbacks                                       |
| Cost visibility                  | Usage ledger and summaries by model/provider/key, priced from LiteLLM + OpenRouter with manual overrides            |

## Business rules (enforced in code)

- Limits are checked before a request and recorded after it, so concurrent in-flight requests can overshoot by their own cost.
- Unknown model price bills $0 and is flagged `price_source=unknown`; `UNPRICED_MODELS=reject` refuses with 422 instead.
- A virtual key is shown once at creation; only its SHA-256 is stored.
- Upstream secrets are AES-256-GCM encrypted with `MASTER_KEY`; losing the key loses every stored secret.
- 429/5xx put a credential on cooldown; 401 retires a static key (`dead`) until its secret is replaced; terminal OAuth refresh errors retire the account until it signs in again.
- A request the upstream rejects as invalid (400/404/422) is returned as-is; it is not retried elsewhere.

## Constraints

- **Single replica**: counters live in SQLite, pool/cooldown state and OAuth login sessions in memory.
- Kiro and Antigravity use undocumented vendor protocols and can break without notice.
- Not supported: Anthropic server tools (`web_search_*`), `count_tokens`, Responses API.
- `packages/utils` is a starter library with no product role yet.
