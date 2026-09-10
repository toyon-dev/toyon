// Where the daemon and the shell's icon are, relative to this file, in each layout the CLI runs
// from: the source tree (cli/src beside daemon/src) or the npm package (dist/ holding the bundled
// daemon.js and the shell). The daemon has the same test in core/assets.ts for its own neighbours.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const here = dirname(fileURLToPath(import.meta.url));
const packaged = existsSync(join(here, "daemon.js"));

/** what to hand bun to start the daemon */
export const daemonEntry = packaged ? join(here, "daemon.js") : join(here, "../../daemon/src/index.ts");
/** the shell's icon, for the macOS app bundle */
export const iconSvg = packaged ? join(here, "shell", "icon.svg") : join(here, "../../shell/public/icon.svg");
