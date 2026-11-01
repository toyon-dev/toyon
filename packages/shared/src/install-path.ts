// The install a bare `toyon` reaches: the node half of update.ts, kept out of index.ts so the
// shell's bundle never sees it. The CLI reads it for the restart command it prints, the daemon
// for whether an npx start has a global install to offer.

import { existsSync, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { InstallMethod } from "./model.ts";
import { installMethod } from "./update.ts";

/** npx puts its own copy first on PATH, so its directories are passed over */
export function installOnPath(path = process.env.PATH ?? ""): InstallMethod {
  for (const dir of path.split(delimiter)) {
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
