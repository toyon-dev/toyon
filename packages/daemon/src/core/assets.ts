// Where the shell and the bridge script are, in each layout the daemon runs from. Three today:
// the source tree (`bun run daemon`, dists beside the packages), the npm package (one bundled
// daemon.js with the dists copied next to it), and later a compiled binary with the same
// neighbours. The env overrides exist for the nested toyon-in-toyon case and for tests.

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export interface Assets {
  shellDist: string;
  bridgeJs: string;
  /** the checkout the daemon is running from, or null for the npm package, which has no tree
   * behind it and so can never be behind one (core/self.ts) */
  sourceRoot: string | null;
  /** the installed package's package.json, one directory above the entry, which an install
   * replaces under the running daemon; null in the source tree */
  packageJson: string | null;
}

/** `here` is the directory of the running entry: packages/daemon/src in the tree, dist/ in the package */
export function locateAssets(here: string, env: NodeJS.ProcessEnv = process.env): Assets {
  const packaged = existsSync(join(here, "shell", "index.html"));
  return {
    shellDist: env.TOYON_SHELL_DIST ?? (packaged ? join(here, "shell") : join(here, "../../shell/dist")),
    bridgeJs: env.TOYON_BRIDGE_JS ?? (packaged ? join(here, "bridge.js") : join(here, "../../bridge/dist/bridge.js")),
    sourceRoot: packaged ? null : resolve(here, "../../.."),
    packageJson: packaged ? join(here, "..", "package.json") : null,
  };
}

/** How long an old build's chunks are kept once a newer build has landed on top of them. The
 * shell builds with `emptyOutDir: false` so that a tab open across a rebuild can still import the
 * names it booted with; that only works while the files are there, and a tab idle for longer than
 * this has a reload coming for other reasons. Measured against the newest file rather than the
 * clock, so a daemon started weeks after the last build does not throw that build away. */
const KEEP_MS = 3 * 24 * 60 * 60 * 1000;

/** Delete the hashed assets left behind by builds the newest one has outlived, and answer how many
 * went. Only `assets/` is considered: everything Vite fingerprints lands there, and every file
 * outside it (index.html, the icons, the service worker) keeps one name across builds and is
 * overwritten in place. Called at boot, where a directory a rebuild is writing into right now is
 * not a case that can arise. */
export function pruneAssets(shellDist: string): number {
  const dir = join(shellDist, "assets");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0; // nothing built yet, or a packaged layout with no assets dir
  }
  const found: { path: string; mtime: number }[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      found.push({ path, mtime: statSync(path).mtimeMs });
    } catch {
      // vanished between the listing and the stat; nothing to prune
    }
  }
  if (found.length === 0) return 0;
  const newest = Math.max(...found.map((f) => f.mtime));
  let gone = 0;
  for (const f of found) {
    if (newest - f.mtime <= KEEP_MS) continue;
    try {
      rmSync(f.path, { recursive: true, force: true });
      gone++;
    } catch {
      // a file we cannot remove is not worth failing a boot over
    }
  }
  return gone;
}
