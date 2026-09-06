import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4142,
    proxy: {
      "/ws": { target: "ws://127.0.0.1:4141", ws: true },
      "/health": "http://127.0.0.1:4141",
    },
  },
});
