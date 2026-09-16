#!/bin/sh
# Toyon's own `afterLand`: catch the main checkout up to what just landed, doing only what the
# landed paths ask for.
#
# The daemon serving this checkout reads packages/shell/dist off disk, so a land that touched the
# shell, the bridge or shared is not seen until the bundles are rebuilt, while one that touched
# only the daemon needs the restart the bar chip offers, and a build would be minutes for nothing.
# The commit each build came from is kept beside it: the next land builds only if something the
# bundles are made of moved since, and installs only if the lockfile did.
set -eu
dist=packages/shell/dist
stamp=$dist/.built
head=$(git rev-parse HEAD)
from=$(cat "$stamp" 2>/dev/null || true)
if [ -n "$from" ] && git cat-file -e "$from^{commit}" 2>/dev/null; then
  changed=$(git diff --name-only "$from" "$head")
else
  # no build on record, or one from a commit this history no longer has: do all of it
  changed="bun.lock"
fi
case "$changed" in
  *bun.lock*) bun install --frozen-lockfile ;;
esac
case "$changed" in
  *bun.lock* | *packages/shell/* | *packages/bridge/* | *packages/shared/*) bun run build ;;
  *) echo "bundles built from $from cover this land; nothing to build" ;;
esac
mkdir -p "$dist"
printf '%s\n' "$head" >"$stamp"
