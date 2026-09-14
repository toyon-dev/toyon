import { DAEMON_DEFAULT_PORT, SHELL_DEV_PORT } from "@toyon/shared/ports";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Both defaults are for `bun run shell:dev` against the daemon you started by hand. Run as a
// toyon proc (.toyon/settings.json), the supervisor hands us $PORT to listen on and the sibling daemon's
// URL: 4141 is then the outer daemon, the one running this worktree, and talking to it would
// make the preview a mirror of the shell framing it rather than its own instance.
const port = Number(process.env.PORT) || SHELL_DEV_PORT;
const daemon = process.env.TOYON_DAEMON_URL || `http://127.0.0.1:${DAEMON_DEFAULT_PORT}`;
const target = { target: daemon, changeOrigin: true };

export default defineConfig({
  plugins: [react()],
  build: {
    // A rebuild rotates every hashed chunk name, and the daemon serves this directory straight off
    // disk: clearing it first pulls the chunks out from under whatever tabs are already open, which
    // is the whole of the stale-build card people see after landing. Every name here is
    // fingerprinted, so leaving the old ones costs disk and nothing else; the daemon prunes builds
    // it has outlived at boot (core/assets.ts).
    emptyOutDir: false,
  },
  server: {
    port,
    // under toyon the supervisor polls this exact port and the preview proxy forwards to it, so
    // sliding to the next free one would leave the preview pointing at nothing: fail in the proc
    // tab instead. By hand, sliding is what you want when 4142 is already yours.
    strictPort: Boolean(process.env.PORT),
    proxy: {
      "/ws": { ...target, ws: true },
      "/health": target,
      "/bootstrap": target,
      // chat image thumbnails; the daemon serves them, so dev has to forward them like /ws
      "/attachments": target,
    },
  },
});
