// `toyon helper`: what the hidden helper bundle runs (daemon/core/helper.ts) with whatever the
// system handed it. A link on the scheme means the daemon up and nothing opened: the page that
// opened the link reloads itself once the daemon answers. Anything else is a file or folder from
// Finder's Open With, as a file URL from Launch Services or a plain path from a drop; each goes to
// the daemon's open route and one app window shows them.

import { fileURLToPath } from "node:url";
import { APP_SCHEME } from "@toyon/shared";
import { showAppWindow } from "./app.ts";
import { ensureDaemon, post } from "./daemon.ts";

export type HelperPlan = { kind: "start" } | { kind: "open"; paths: string[] };

/** what the arguments ask for: a link on the scheme, or nothing, is a start; the rest are paths */
export function planHelper(args: string[]): HelperPlan {
  if (args.some((a) => a.startsWith(`${APP_SCHEME}:`))) return { kind: "start" };
  const paths: string[] = [];
  for (const a of args) {
    if (a.startsWith("file:")) {
      try {
        const p = fileURLToPath(a);
        if (p !== "" && p !== "/") paths.push(p);
      } catch {
        // a file URL with nothing in it, or not a file URL at all: nothing to open
      }
    } else if (a !== "") paths.push(a);
  }
  return paths.length === 0 ? { kind: "start" } : { kind: "open", paths };
}

export async function helper(args: string[]): Promise<number> {
  const plan = planHelper(args);
  // the launcher log is the only trace of what the system handed over
  console.log(`toyon helper: ${args.length > 0 ? args.join(" ") : "(nothing)"}`);
  const daemon = await ensureDaemon();
  if (!daemon) return 1;
  if (plan.kind === "start") return 0;
  for (const path of plan.paths) {
    const res = await post("/open", daemon.token, { path });
    if (!res.ok) console.error(`could not open ${path}: ${await res.text()}`);
  }
  showAppWindow(daemon);
  return 0;
}
