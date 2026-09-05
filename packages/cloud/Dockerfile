# Orchardist daemon in a Fly Machine. Build context is the monorepo root
# (provision.sh passes it), never this directory alone: the daemon resolves
# packages/shell/dist and packages/bridge/dist relative to its own source.
#
# glibc base so the agent SDK / esbuild / rollup pick their -linux-x64 builds.
FROM oven/bun:1-debian

RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates openssh-client \
 && rm -rf /var/lib/apt/lists/*

# Claude Code refuses bypassPermissions as root, so everything runs as `orch`.
RUN useradd --create-home --uid 1001 --shell /bin/bash orch

WORKDIR /app
COPY --chown=orch:orch . .

USER orch
# fresh install inside the image: never copy a macOS node_modules in
RUN bun install --frozen-lockfile && bun run build

USER root
COPY packages/cloud/entrypoint.sh /entrypoint.sh
RUN chmod 0755 /entrypoint.sh

ENV ORCHARDIST_CLOUD=1 \
    ORCHARDIST_PORT=4141 \
    ORCHARDIST_HOME=/data/orchardist \
    ORCHARDIST_PROXY_PORTS=10001-10008 \
    HOME=/data/home

EXPOSE 4141 10001 10002 10003 10004 10005 10006 10007 10008
ENTRYPOINT ["/entrypoint.sh"]
