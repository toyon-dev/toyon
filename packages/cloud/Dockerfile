# Toyon daemon in a Fly Machine. Build context is the monorepo root
# (provision.sh passes it), never this directory alone: the daemon resolves
# packages/shell/dist and packages/bridge/dist relative to its own source.
#
# glibc base so the agent SDK / esbuild / rollup pick their -linux-x64 builds.
# bubblewrap + socat: Claude Code sandboxes Bash by default and refuses to run
# without them (SandboxSettings.failIfUnavailable defaults to true). Codex's
# workspace-write sandbox on Linux uses bubblewrap/landlock too. The ACP
# adapters are installed into the image (TOYON_AGENTS_DIR) so a machine never
# downloads them at boot; they run under bun, no node binary needed.
FROM oven/bun:1-debian

RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates openssh-client bubblewrap socat \
 && rm -rf /var/lib/apt/lists/*

# Claude Code refuses bypassPermissions as root, so everything runs as `orch`.
RUN useradd --create-home --uid 1001 --shell /bin/bash orch

WORKDIR /app
COPY . .

# fresh install inside the image (never copy a macOS node_modules in); done as
# root because bun needs a writable HOME for its cache, then handed to orch
RUN bun install --frozen-lockfile && bun run build \
 && TOYON_AGENTS_DIR=/app/agents TOYON_HOME=/tmp/toyon-build bun packages/daemon/scripts/install-agents.ts \
 && chown -R orch:orch /app

COPY packages/cloud/entrypoint.sh /entrypoint.sh
RUN chmod 0755 /entrypoint.sh

ENV TOYON_CLOUD=1 \
    TOYON_PORT=4141 \
    TOYON_HOME=/data/toyon \
    TOYON_AGENTS_DIR=/app/agents \
    TOYON_PROXY_PORTS=10001-10008 \
    HOME=/data/home

EXPOSE 4141 10001 10002 10003 10004 10005 10006 10007 10008
ENTRYPOINT ["/entrypoint.sh"]
