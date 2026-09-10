// Where the shell and the bridge script are, in each layout the daemon runs from. Three today:
// the source tree (`bun run daemon`, dists beside the packages), the npm package (one bundled
// daemon.js with the dists copied next to it), and later a compiled binary with the same
// neighbours. The env overrides exist for the nested toyon-in-toyon case and for tests.

import { existsSync } from "node:fs";
import { join } from "node:path";

export interface Assets {
  shellDist: string;
  bridgeJs: string;
}

/** `here` is the directory of the running entry: packages/daemon/src in the tree, dist/ in the package */
export function locateAssets(here: string, env: NodeJS.ProcessEnv = process.env): Assets {
  const packaged = existsSync(join(here, "shell", "index.html"));
  return {
    shellDist: env.TOYON_SHELL_DIST ?? (packaged ? join(here, "shell") : join(here, "../../shell/dist")),
    bridgeJs: env.TOYON_BRIDGE_JS ?? (packaged ? join(here, "bridge.js") : join(here, "../../bridge/dist/bridge.js")),
  };
}
