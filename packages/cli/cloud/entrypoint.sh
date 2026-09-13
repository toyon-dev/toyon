#!/bin/sh
# Runs as root only long enough to own the volume and move the secrets out of the environment, then
# drops to `toyon`. /data is the volume: state, transcripts, worktrees, the repo, the agent adapters,
# and HOME (so ~/.claude and bun's cache survive restarts).
set -eu

export TOYON_HOME="${TOYON_HOME:-/data/toyon}"
mkdir -p /data/home "$TOYON_HOME"

# Platform secrets arrive in the environment, and everything the daemon starts inherits its
# environment. The token and the git credentials go to files in TOYON_HOME, which the daemon reads
# and no agent may (packages/daemon/src/agent/sandbox.ts), and leave the environment before it starts.
if [ -n "${TOYON_TOKEN:-}" ]; then
  (umask 077 && printf %s "$TOYON_TOKEN" > "$TOYON_HOME/token")
fi
if [ -n "${GITHUB_TOKEN:-}" ]; then
  (umask 077 && printf 'https://x-access-token:%s@github.com\n' "$GITHUB_TOKEN" > "$TOYON_HOME/git-credentials")
fi
unset TOYON_TOKEN GITHUB_TOKEN
chown -R toyon:toyon /data

exec runuser -u toyon -- /bin/sh -c '
set -eu
export HOME=/data/home

git config --global user.name  >/dev/null 2>&1 || git config --global user.name  "toyon"
git config --global user.email >/dev/null 2>&1 || git config --global user.email "toyon@localhost"
git config --global init.defaultBranch main
if [ -f "$TOYON_HOME/git-credentials" ]; then
  git config --global credential.helper "store --file=$TOYON_HOME/git-credentials"
fi

REPO=/data/repo
if [ ! -d "$REPO/.git" ]; then
  if [ -n "${TOYON_REPO_URL:-}" ]; then
    echo "cloning $TOYON_REPO_URL"
    git clone "$TOYON_REPO_URL" "$REPO"
  else
    echo "scaffolding a vite react-ts starter"
    (cd /data && bunx --bun create-vite@latest repo --template react-ts < /dev/null)
    # the run contract: listen on $PORT (vite ignores the variable by default)
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
    # explicit settings: without them the daemon treats the detected procs as a guess and starts
    # nothing until the first-run card confirms
    mkdir -p "$REPO/.toyon"
    cat > "$REPO/.toyon/settings.json" <<EOF
{ "setup": ["bun install"], "run": { "web": "bun run dev" } }
EOF
    (cd "$REPO" && bun install)
    (cd "$REPO" && git init -q && git add -A && git commit -qm "vite react-ts starter")
  fi
fi

exec bun /app/dist/daemon.js "$REPO"
'
