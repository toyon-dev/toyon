// Path completion for the project picker: what directories could finish the path being typed.
// Read-only and directory-only — the daemon already registers repos and runs their commands, so
// this adds no reach, but it stays a listing and never opens a file.

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

const NOWHERE: PathTarget = { exists: false, isDir: false, isRepo: false, parentExists: false };

/** what the typed path itself is. The entries answer "what is inside here"; this answers "is there
 * a here", which is what decides whether the picker may offer to make a project at it. */
function describe(typed: string, parent: string): PathTarget {
  let isDir = false;
  try {
    isDir = statSync(typed).isDirectory();
  } catch {
    // no such path: that is an answer, and the common one while someone is still typing
  }
  // .git is a directory in a checkout and a file in a linked worktree; both are openable
  return {
    exists: existsSync(typed),
    isDir,
    isRepo: isDir && existsSync(join(typed, ".git")),
    parentExists: existsSync(parent),
  };
}

/** Directories that could complete `raw`, repos first, plus what `raw` itself is. A trailing slash
 * lists the directory itself; anything else treats the last segment as a prefix to match. */
export async function browsePath(raw: string): Promise<{ entries: PathEntry[]; target: PathTarget }> {
  const typed = expandTilde(raw.trim());
  if (!typed.startsWith("/")) return { entries: [], target: NOWHERE };
  // "…/foo" means "entries of … starting with foo"; "…/" means "everything in …"
  const listing = typed.endsWith("/");
  const dir = listing ? typed : dirname(typed);
  const prefix = listing ? "" : typed.slice(dir.length).replace(/^\//, "").toLowerCase();
  // a trailing slash names the directory itself, so it is its own parent for this purpose
  const target = describe(listing ? typed.replace(/\/+$/, "") : typed, dir);

  let names: string[];
  try {
    const found = await readdir(dir, { withFileTypes: true });
    names = found.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);
  } catch {
    // missing, unreadable or not a directory: nothing to offer, and no error worth a word. The
    // target still says which of those it was, which is the whole reason it is reported separately
    return { entries: [], target };
  }

  const entries: PathEntry[] = [];
  for (const name of names) {
    // dotfiles stay hidden until they are being typed, the way a shell completes them
    if (name.startsWith(".") && !prefix.startsWith(".")) continue;
    if (!name.toLowerCase().startsWith(prefix)) continue;
    const abs = join(dir, name);
    // .git is a directory in a checkout and a file in a linked worktree; both are openable
    entries.push({ path: collapseTilde(abs), name, isRepo: existsSync(join(abs, ".git")) });
  }
  entries.sort((a, b) => (a.isRepo !== b.isRepo ? (a.isRepo ? -1 : 1) : a.name.localeCompare(b.name)));
  return { entries: entries.slice(0, MAX_ENTRIES), target };
}
