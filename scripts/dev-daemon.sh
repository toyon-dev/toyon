#!/bin/sh
# The daemon as a toyon proc, so toyon can run toyon.
#
# Two things have to move for a nested daemon. It binds $PORT, the port the supervisor polls to
# call the proc up and the preview proxy forwards to; the default 4141 belongs to whichever daemon
# is running this one. And it keeps its state elsewhere: state.json holds live records the daemon
# mutates and rewrites whole, so two daemons sharing ~/.toyon clobber each other's worktrees. One
# state dir per worktree, named after it, so parallel worktrees stay independent and a restart
# finds the same token (the shell holds that per origin, in localStorage).
set -eu
: "${PORT:?no PORT in the environment: run this through Toyon, not by hand}"
exec env \
  TOYON_PORT="$PORT" \
  TOYON_HOME="${TOYON_DEV_HOME:-$HOME/.toyon-dev/$(basename "$(pwd)")}" \
  bun run --cwd packages/daemon dev
