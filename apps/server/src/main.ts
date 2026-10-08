import { serve } from "@hono/node-server";
import { createServices } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createLogger } from "./logger.ts";
import { startModelSync } from "./models.ts";
import { startPricingScheduler } from "./pricing/sync.ts";

const config = loadConfig();
const log = createLogger();
const { app, pricing, models } = createServices(config, { log });

const stopPricing = config.PRICING_SYNC_ENABLED
  ? startPricingScheduler(
      { store: pricing, log: (m) => log.info(m) },
      config.PRICING_SYNC_INTERVAL_HOURS * 3_600_000,
    )
  : () => {};

const stopModels =
  config.MODEL_SYNC_INTERVAL_HOURS > 0
    ? startModelSync(models, config.MODEL_SYNC_INTERVAL_HOURS * 3_600_000)
    : () => {};

const server = serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST }, (info) => {
  log.info("listening", { host: info.address, port: info.port });
});

function shutdown() {
  stopPricing();
  stopModels();
  server.close((error) => process.exit(error ? 1 : 0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
