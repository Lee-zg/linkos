import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";

const webTLS =
  process.env.LINKOS_WEB_TLS_CERT && process.env.LINKOS_WEB_TLS_KEY
    ? {
        cert: readFileSync(process.env.LINKOS_WEB_TLS_CERT),
        key: readFileSync(process.env.LINKOS_WEB_TLS_KEY),
      }
    : undefined;

const gatewayEntry = process.env.LINKOS_WEB_GATEWAY_ENTRY === "1";
const entryURL = new URL(
  process.env.LINKOS_WEB_ENTRY_URL ?? "http://127.0.0.1:8787",
);

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "linkos-development-instance",
      configureServer(server) {
        // Vite otherwise advertises VPN/VM adapters too, including IPs outside
        // the development certificate. Show only launcher-selected LAN URLs.
        const printURLs = server.printUrls.bind(server);
        server.printUrls = () => {
          if (server.resolvedUrls && process.env.LINKOS_WEB_LAN_URLS)
            server.resolvedUrls.network = JSON.parse(
              process.env.LINKOS_WEB_LAN_URLS,
            ).map((url: string) => url + "/");
          printURLs();
        };
        server.middlewares.use("/__linkos/dev", (_req, res) => {
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              service: "web",
              projectId: process.env.LINKOS_PROJECT_ID ?? "",
              host: process.env.LINKOS_WEB_HOST ?? "127.0.0.1",
              lanURLs: JSON.parse(process.env.LINKOS_WEB_LAN_URLS ?? "[]"),
              gatewayURL:
                process.env.LINKOS_GATEWAY_URL ?? "http://127.0.0.1:8787",
            }),
          );
        });
      },
    },
  ],
  server: {
    port: Number(process.env.LINKOS_WEB_PORT ?? 0),
    host: process.env.LINKOS_WEB_HOST ?? "127.0.0.1",
    https: webTLS,
    strictPort: true,
    hmr: gatewayEntry
      ? {
          path: "/__linkos/hmr",
          protocol: entryURL.protocol === "https:" ? "wss" : "ws",
          clientPort: Number(entryURL.port),
        }
      : undefined,
    proxy: gatewayEntry
      ? undefined
      : {
          "/api": {
            target: process.env.LINKOS_GATEWAY_URL ?? "http://127.0.0.1:8787",
            ws: true,
          },
        },
    watch: {
      ignored: ["**/test-results-*/**"],
    },
  },
  build: { target: "es2022", sourcemap: true },
});
