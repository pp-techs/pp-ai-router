import { serve } from "@hono/node-server";
import { createServices } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createLogger } from "./logger.ts";
import { startModelSync } from "./models.ts";
import { startPricingScheduler } from "./pricing/sync.ts";
import { startQuotaSync } from "./quota/service.ts";

const config = loadConfig();
const log = createLogger();
const { app, pricing, metadata, models, quota } = createServices(config, { log });

const stopPricing = config.PRICING_SYNC_ENABLED
  ? startPricingScheduler(
      { store: pricing, metadata, log: (m) => log.info(m) },
      config.PRICING_SYNC_INTERVAL_HOURS * 3_600_000,
    )
  : () => {};

const stopModels =
  config.MODEL_SYNC_INTERVAL_HOURS > 0
    ? startModelSync(models, config.MODEL_SYNC_INTERVAL_HOURS * 3_600_000)
    : () => {};

const stopQuota =
  config.QUOTA_SYNC_INTERVAL_MINUTES > 0
    ? startQuotaSync(quota, config.QUOTA_SYNC_INTERVAL_MINUTES * 60_000)
    : () => {};

const server = serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST }, (info) => {
  log.info("listening", { host: info.address, port: info.port });
});

function shutdown() {
  stopPricing();
  stopModels();
  stopQuota();
  server.close((error) => process.exit(error ? 1 : 0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
