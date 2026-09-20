// The worktree's files as the tree shows them: what is on disk now, not what the index still holds.

/**
 * The files a worktree has, the submodules among its entries (which open as nothing), and what
 * git ignores: an ignored file by its path, and a folder ignored whole as its path with a trailing
 * slash, one row standing for everything inside it.
 */
export interface Listing {
  paths: string[];
  submodules: string[];
  ignored: string[];
}

/** a gitlink: the entry is another repository's commit, not a file */
const SUBMODULE_MODE = "160000";

const entries = (out: string) => out.split("\0").filter(Boolean);

/**
 * Parse four `git ls-files -z` outputs: `-s` (tracked, with modes), `-o --exclude-standard`
 * (untracked), `-d` (tracked but gone from disk) and `-o -i --exclude-standard --directory`
 * (ignored, with a folder ignored whole collapsed to one entry). `-c` alone keeps a deleted or
 * renamed file listed until the change is staged, and names a conflicted file once per merge stage.
 */
export function parseListing(staged: string, untracked: string, deleted: string, ignored = ""): Listing {
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
  return { paths: [...paths], submodules: [...submodules], ignored: collapse(entries(ignored)) };
}

/**
 * Git can name a folder as ignored whole and still list entries under it (a rule in the repo's
 * exclude file and one in .gitignore matching the same tree). The collapsed row stands for all of
 * them, so what sits under one is dropped.
 */
function collapse(list: string[]): string[] {
  const out: string[] = [];
  let under: string | null = null;
  // sorted by code unit, everything under "a/" follows it directly: "a/" < "a/b" < "a0"
  for (const p of [...list].sort()) {
    if (under !== null && p.startsWith(under)) continue;
    under = p.endsWith("/") ? p : null;
    out.push(p);
  }
  return out;
}
