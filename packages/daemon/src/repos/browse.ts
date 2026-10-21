// Path completion for the project picker: what folders and files could finish the path being
// typed. Read-only — the daemon already registers repos and runs their commands, so this adds no
// reach; it stays a listing, and a file it lists is opened only by the open service's own door.

import { existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ChosenFolder, PathEntry, PathTarget } from "@toyon/shared";

/** a long directory (node_modules, /usr/bin) would flood the picker; the prefix narrows it anyway */
const MAX_ENTRIES = 40;

/** "~/x" is how people type paths and no shell expanded this one */
export function expandTilde(raw: string): string {
  return raw === "~" || raw.startsWith("~/") ? join(homedir(), raw.slice(1)) : raw;
}

/** the inverse, so a completed row reads (and types back) the way it was written */
function collapseTilde(abs: string): string {
  const home = homedir();
  return abs === home || abs.startsWith(`${home}/`) ? `~${abs.slice(home.length)}` : abs;
}

/** Finder leaves a .DS_Store in any folder it has shown, so a folder made for a project and looked
 * at once still holds nothing */
export function holdsNothing(names: string[]): boolean {
  return names.every((n) => n === ".DS_Store");
}

/** what a folder picked in the OS dialog is, for the new-project form to decide what to do with it */
export async function describeFolder(abs: string): Promise<ChosenFolder> {
  const path = collapseTilde(abs);
  // .git is a directory in a checkout and a file in a linked worktree; both are projects already
  if (existsSync(join(abs, ".git"))) return { path, kind: "project" };
  try {
    return { path, kind: holdsNothing(await readdir(abs)) ? "empty" : "folder" };
  } catch {
    // unreadable: not somewhere to make a project in place, and a create there will say why
    return { path, kind: "folder" };
  }
}

const NOWHERE: PathTarget = { exists: false, isDir: false, isRepo: false, isFile: false, parentExists: false };

/** what the typed path itself is. The entries answer "what is inside here"; this answers "is there
 * a here", which is what decides whether the picker may offer to make a project at it. */
function describe(typed: string, parent: string): PathTarget {
  let isDir = false;
  let isFile = false;
  try {
    const st = statSync(typed);
    isDir = st.isDirectory();
    isFile = st.isFile();
  } catch {
    // no such path: that is an answer, and the common one while someone is still typing
  }
  // .git is a directory in a checkout and a file in a linked worktree; both are openable
  return {
    exists: existsSync(typed),
    isDir,
    isRepo: isDir && existsSync(join(typed, ".git")),
    isFile,
    parentExists: existsSync(parent),
  };
}

/** Folders and files that could complete `raw`, repos first and files last, plus what `raw` itself
 * is. A trailing slash lists the directory itself; anything else treats the last segment as a
 * prefix to match. */
export async function browsePath(raw: string): Promise<{ entries: PathEntry[]; target: PathTarget }> {
  const typed = expandTilde(raw.trim());
  if (!typed.startsWith("/")) return { entries: [], target: NOWHERE };
  // "…/foo" means "entries of … starting with foo"; "…/" means "everything in …"
  const listing = typed.endsWith("/");
  const dir = listing ? typed : dirname(typed);
  const prefix = listing ? "" : typed.slice(dir.length).replace(/^\//, "").toLowerCase();
  // a trailing slash names the directory itself, so it is its own parent for this purpose
  const target = describe(listing ? typed.replace(/\/+$/, "") : typed, dir);

  let found: { name: string; isFile: boolean }[];
  try {
    const listed = await readdir(dir, { withFileTypes: true });
    // a symlink is listed as what it points at, so a link to a file opens and a link to a folder
    // descends; a socket or a pipe is neither and is left out
    found = listed
      .map((e) => ({
        name: e.name,
        isFile: e.isSymbolicLink() ? isFileAt(join(dir, e.name)) : e.isFile() ? true : e.isDirectory() ? false : null,
      }))
      .filter((e): e is { name: string; isFile: boolean } => e.isFile !== null);
  } catch {
    // missing, unreadable or not a directory: nothing to offer, and no error worth a word. The
    // target still says which of those it was, which is the whole reason it is reported separately
    return { entries: [], target };
  }

  const entries: PathEntry[] = [];
  for (const { name, isFile } of found) {
    // dotfiles stay hidden until they are being typed, the way a shell completes them
    if (name.startsWith(".") && !prefix.startsWith(".")) continue;
    if (!name.toLowerCase().startsWith(prefix)) continue;
    const abs = join(dir, name);
    // .git is a directory in a checkout and a file in a linked worktree; both are openable
    entries.push({ path: collapseTilde(abs), name, isRepo: !isFile && existsSync(join(abs, ".git")), isFile });
  }
  // repos lead and files trail: the picker is reached for projects first, and a folder of many
  // files would otherwise push the folders in it past the cap
  const rank = (e: PathEntry) => (e.isRepo ? 0 : e.isFile ? 2 : 1);
  entries.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return { entries: entries.slice(0, MAX_ENTRIES), target };
}

/** what a symlink points at: a file, a folder, or (null) nothing that is either, a dangling link
 * or a socket among them, which the listing leaves out */
function isFileAt(abs: string): boolean | null {
  try {
    const st = statSync(abs);
    return st.isFile() ? true : st.isDirectory() ? false : null;
  } catch {
    // a dangling link is not somewhere to go
    return null;
  }
}
