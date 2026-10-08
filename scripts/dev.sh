#!/bin/sh
# The daemon or the Vite shell as a toyon proc, so toyon can run toyon: `dev.sh daemon` or
# `dev.sh shell`.
#
# Two things have to move for a nested daemon. It binds $PORT, the port the supervisor polls to
# call the proc up and the preview proxy forwards to; the default 4141 belongs to whichever daemon
# is running this one. And it keeps its state elsewhere: state.json holds live records the daemon
# mutates and rewrites whole, so two daemons sharing ~/.toyon clobber each other's worktrees. One
# state dir per worktree, named after it, so parallel worktrees stay independent and a restart
# finds the same token.
#
# The shell is told the same state dir, because the preview is a browser origin that has never
# held this daemon's token and would otherwise knock with nobody to answer: Vite reads the token
# from there and writes it into the page (vite.config.ts). Both roles derive the dir here so the
# two cannot drift apart.
set -eu
: "${PORT:?no PORT in the environment: run this through Toyon, not by hand}"
home="${TOYON_DEV_HOME:-$HOME/.toyon-dev/$(basename "$(pwd)")}"
case "${1:-}" in
  daemon) exec env TOYON_PORT="$PORT" TOYON_HOME="$home" bun run --cwd packages/daemon dev ;;
  shell)
    : "${DAEMON_URL:?no DAEMON_URL in the environment: the daemon proc has to run beside this one}"
    exec env TOYON_DAEMON_URL="$DAEMON_URL" TOYON_HOME="$home" bun run --cwd packages/shell dev
    ;;
  *) echo "usage: scripts/dev.sh daemon|shell" >&2; exit 2 ;;
esac
