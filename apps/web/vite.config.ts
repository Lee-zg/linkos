import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "linkos-development-instance",
      configureServer(server) {
        server.middlewares.use("/__linkos/dev", (_req, res) => {
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              service: "web",
              projectId: process.env.LINKOS_PROJECT_ID ?? "",
              gatewayURL:
                process.env.LINKOS_GATEWAY_URL ?? "http://127.0.0.1:8787",
            }),
          );
        });
      },
    },
  ],
  server: {
    port: Number(process.env.LINKOS_WEB_PORT ?? 5173),
    host: "127.0.0.1",
    strictPort: true,
    proxy: {
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
