import { DAEMON_DEFAULT_PORT, SHELL_DEV_PORT } from "@toyon/shared/ports";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: SHELL_DEV_PORT,
    proxy: {
      "/ws": { target: `ws://127.0.0.1:${DAEMON_DEFAULT_PORT}`, ws: true },
      "/health": `http://127.0.0.1:${DAEMON_DEFAULT_PORT}`,
    },
  },
});
