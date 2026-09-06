// Path containment helpers shared by the agent permission policy, the sandbox settings writer
// and the daemon's own resolveInside: the same symlink rule everywhere, or a link inside the
// worktree pointing elsewhere confines one layer and not the other.

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";

/** Resolve symlinks on the deepest existing ancestor so a link inside the
 * worktree pointing elsewhere can't smuggle a write out. */
export function canonical(p: string): string {
  let probe = p;
  const tail: string[] = [];
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return p;
    tail.unshift(basename(probe));
    probe = parent;
  }
  try {
    return resolve(realpathSync(probe), ...tail);
  } catch {
    return p;
  }
}

export function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep);
}
