// How an installed Toyon updates, read the same way by the daemon (the chip, the automatic path)
// and the CLI (`toyon update`). Pure: where a package sits and what a version string says.

import type { InstallMethod } from "./model.ts";

/** Read from where the installed package.json sits. npm keeps global packages under a
 * node_modules in its prefix, bun under .bun/install/global, and npx runs a copy out of its own
 * cache, which a newer version never replaces. */
export function installMethod(packageJson: string | null): InstallMethod {
  if (!packageJson) return "none";
  const p = packageJson.replaceAll("\\", "/");
  if (p.includes("/_npx/")) return "npx";
  if (p.includes("/.bun/install/global/")) return "bun";
  if (p.includes("/node_modules/toyon/")) return "npm";
  return "none";
}

/** The command that installs `version`, which is also what a person runs when an install from the
 * app fails. Null where nothing installs: npx runs whatever version it is asked for. */
export function installCommand(method: InstallMethod, version: string): string[] | null {
  if (method === "npm") return ["npm", "install", "-g", `toyon@${version}`];
  if (method === "bun") return ["bun", "add", "-g", `toyon@${version}`];
  return null;
}

/** Whether version `a` is newer than `b`, for the `major.minor.patch` and `-pre` versions npm
 * publishes. A prerelease is older than its release; two prereleases of one release compare by
 * their tag's text. Anything that is not a version is never newer. */
export function newer(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    const x = pa.nums[i] ?? 0;
    const y = pb.nums[i] ?? 0;
    if (x !== y) return x > y;
  }
  if (pa.pre === pb.pre) return false;
  if (pa.pre === null) return true;
  if (pb.pre === null) return false;
  return pa.pre > pb.pre;
}

function parseVersion(v: string): { nums: number[]; pre: string | null } | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
}
