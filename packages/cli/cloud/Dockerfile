# The toyon machine: the CLI's bundled daemon and shell, run under bun. The build context is the one
# packages/cli/src/deploy/context.ts writes (dist/, package.json, this file, entrypoint.sh), so the
# image holds exactly the package that built it. BUN_VERSION comes from the CLI's own dependency.
#
# A glibc base, so bun-pty and the agent adapters pick their linux-x64 builds. bubblewrap and socat:
# Claude Code sandboxes Bash and refuses to run without them, Codex's workspace-write sandbox uses
# bubblewrap, and so does toyon's own sandbox for an agent that brings none.
ARG BUN_VERSION
FROM oven/bun:${BUN_VERSION}-debian

RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates openssh-client bubblewrap socat \
 && rm -rf /var/lib/apt/lists/*

# Claude Code refuses bypassPermissions as root, so the daemon runs as `toyon`.
RUN useradd --create-home --uid 1001 --shell /bin/bash toyon

WORKDIR /app
COPY package.json ./
RUN bun install --production
COPY dist ./dist
COPY entrypoint.sh /entrypoint.sh
RUN chmod 0755 /entrypoint.sh && chown -R toyon:toyon /app

# The agent adapters install on first boot, onto the volume under TOYON_HOME, and survive restarts.
ENV TOYON_CLOUD=1 \
    TOYON_PORT=4141 \
    TOYON_HOME=/data/toyon \
    HOME=/data/home

EXPOSE 4141 10001 10002 10003 10004 10005 10006 10007 10008
ENTRYPOINT ["/entrypoint.sh"]
