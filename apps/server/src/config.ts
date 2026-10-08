import * as z from "zod";

const base64Key = z.string().refine((v) => Buffer.from(v, "base64").length === 32, {
  message: "must be base64 of exactly 32 bytes (generate: openssl rand -base64 32)",
});

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default("127.0.0.1"),
  DB_PATH: z.string().default("./data/router.db"),
  MASTER_KEY: base64Key,
  ADMIN_TOKEN: z.string().min(16),
  PRICING_SYNC_ENABLED: z.stringbool().default(true),
  PRICING_SYNC_INTERVAL_HOURS: z.coerce.number().positive().default(24),
  /** How often provider model lists are re-fetched from their upstreams; 0 = only on demand. */
  MODEL_SYNC_INTERVAL_HOURS: z.coerce.number().min(0).default(6),
  /** What to do when a model has no known price: bill $0 and flag it, or refuse the request. */
  UNPRICED_MODELS: z.enum(["allow", "reject"]).default("allow"),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  /** Directory of the built admin UI (apps/web/dist). Unset = API only. */
  WEB_DIST: z.string().min(1).optional(),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
