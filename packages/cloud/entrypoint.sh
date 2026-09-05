#!/bin/sh
# Runs as root only long enough to own the volume, then drops to `orch`.
# /data is the Fly volume: state, transcripts, worktrees, demo repo, and HOME
# (so ~/.claude and bun's cache survive restarts).
set -eu

mkdir -p /data/home /data/orchardist
chown -R orch:orch /data

exec runuser -u orch -- /bin/sh -c '
set -eu
export HOME=/data/home
export PATH="$HOME/.bun/bin:/usr/local/bin:$PATH"
cd /app

git config --global user.name  >/dev/null 2>&1 || git config --global user.name  "orchardist"
git config --global user.email >/dev/null 2>&1 || git config --global user.email "orchardist@localhost"
git config --global init.defaultBranch main

REPO=/data/repo
if [ ! -d "$REPO/.git" ]; then
  if [ -n "${DEMO_REPO_URL:-}" ]; then
    echo "cloning $DEMO_REPO_URL"
    git clone --depth 50 "$DEMO_REPO_URL" "$REPO"
  else
    # Vite React starter, scaffolded fresh so the spike needs no GitHub access.
    echo "scaffolding vite react-ts starter"
    (cd /data && bunx --bun create-vite@latest repo --template react-ts < /dev/null)
    # honour the proc contract: listen on $PORT (vite ignores the env var by default)
    cat > "$REPO/vite.config.ts" <<EOF
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.PORT) || 5173,
    strictPort: true,
  },
});
EOF
    cd "$REPO" && git init -q && git add -A && git commit -qm "vite react-ts starter" && cd /app
  fi
  (cd "$REPO" && bun install)
fi

exec bun run packages/daemon/src/index.ts "$REPO"
'
