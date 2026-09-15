// The worktree's files as the tree shows them: what is on disk now, not what the index still holds.

/** the files a worktree has, and the submodules among its entries, which open as nothing */
export interface Listing {
  paths: string[];
  submodules: string[];
}

/** a gitlink: the entry is another repository's commit, not a file */
const SUBMODULE_MODE = "160000";

const entries = (out: string) => out.split("\0").filter(Boolean);

/**
 * Parse three `git ls-files -z` outputs: `-s` (tracked, with modes), `-o --exclude-standard`
 * (untracked) and `-d` (tracked but gone from disk). `-c` alone keeps a deleted or renamed file
 * listed until the change is staged, and names a conflicted file once per merge stage.
 */
export function parseListing(staged: string, untracked: string, deleted: string): Listing {
  const gone = new Set(entries(deleted));
  const paths = new Set<string>();
  const submodules = new Set<string>();
  for (const line of entries(staged)) {
    // "<mode> <object> <stage>\t<path>"
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const path = line.slice(tab + 1);
    if (gone.has(path)) continue;
    if (line.startsWith(SUBMODULE_MODE)) submodules.add(path);
    else paths.add(path);
  }
  for (const path of entries(untracked)) paths.add(path);
  return { paths: [...paths], submodules: [...submodules] };
}
