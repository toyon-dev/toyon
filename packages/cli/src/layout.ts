// Where the daemon and the shell's icon are, relative to this file, in each layout the CLI runs
// from: the source tree (cli/src beside daemon/src) or the npm package (dist/ holding the bundled
// daemon.js and the shell). The daemon has the same test in core/assets.ts for its own neighbours.

import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type InstallMethod, installMethod, restartCommand } from "@toyon/shared";
import pkg from "../package.json" with { type: "json" };

export const here = dirname(fileURLToPath(import.meta.url));
/** running from the npm package, whose dist/ holds the bundles, rather than from a source tree */
export const packaged = existsSync(join(here, "daemon.js"));

/** how this Toyon was installed, read from where its package sits */
export const method: InstallMethod = installMethod(packaged ? join(here, "..", "package.json") : null);
/** The install a bare `toyon` reaches. npx puts its own copy first on PATH, so its directories
 * are passed over. */
function installOnPath(): InstallMethod {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "" || dir.includes("/_npx/")) continue;
    const bin = join(dir, "toyon");
    if (!existsSync(bin)) continue;
    try {
      return installMethod(realpathSync(bin));
    } catch {
      // a link to nothing; the next directory on PATH may hold a real one
    }
  }
  return "none";
}

/** what restarts the daemon onto this CLI's version */
export const restartCmd = restartCommand(
  method,
  pkg.version,
  method === "npx" ? installOnPath() : "none",
  process.env.npm_config_registry ?? null,
);

/** what to hand bun to start the daemon */
export const daemonEntry = packaged ? join(here, "daemon.js") : join(here, "../../daemon/src/index.ts");
