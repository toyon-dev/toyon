// The worktree's files as git lists them: the index's paths, and what git ignores.

/** the paths in the index, with the submodules among its entries (which open as nothing) apart */
export interface Tracked {
  paths: string[];
  submodules: string[];
}

/** a gitlink: the entry is another repository's commit, not a file */
const SUBMODULE_MODE = "160000";

const entries = (out: string) => out.split("\0").filter(Boolean);

/** Parse `git ls-files -z -s`, which names a conflicted file once per merge stage: a path is
 * listed once, and `unmerged` names the ones held in stages, whose file may not be on disk. */
export function parseTracked(staged: string): Tracked & { unmerged: string[] } {
  const paths = new Set<string>();
  const submodules = new Set<string>();
  const unmerged = new Set<string>();
  for (const line of entries(staged)) {
    // "<mode> <object> <stage>\t<path>"
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const path = line.slice(tab + 1);
    if (line.startsWith(SUBMODULE_MODE)) submodules.add(path);
    else paths.add(path);
    if (line.charAt(tab - 1) !== "0") unmerged.add(path);
  }
  return { paths: [...paths], submodules: [...submodules], unmerged: [...unmerged] };
}

/**
 * Parse `git ls-files -z -o -i --exclude-standard --directory`: an ignored file by its path, and a
 * folder ignored whole as its path with a trailing slash, one entry standing for everything
 * inside it.
 *
 * Git can name a folder as ignored whole and still list entries under it (a rule in the repo's
 * exclude file and one in .gitignore matching the same tree). The collapsed entry stands for all
 * of them, so what sits under one is dropped.
 */
export function parseIgnored(ignored: string): string[] {
  const out: string[] = [];
  let under: string | null = null;
  // sorted by code unit, everything under "a/" follows it directly: "a/" < "a/b" < "a0"
  for (const p of entries(ignored).sort()) {
    if (under !== null && p.startsWith(under)) continue;
    under = p.endsWith("/") ? p : null;
    out.push(p);
  }
  return out;
}
