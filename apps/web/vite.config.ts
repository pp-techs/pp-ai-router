import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

// Dev only: the production server serves this UI and the API from one origin.
// ROUTER_URL points the proxy at a router on another port (default: http://127.0.0.1:8080).
const router = process.env.ROUTER_URL ?? "http://127.0.0.1:8080";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  plugins: [react(), tailwindcss()],
  server: { proxy: { "/admin": router, "/v1": router, "/healthz": router } },
  test: { include: ["src/**/*.test.ts"] },
});
