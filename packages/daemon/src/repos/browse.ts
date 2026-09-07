// Path completion for the project picker: what directories could finish the path being typed.
// Read-only and directory-only — the daemon already registers repos and runs their commands, so
// this adds no reach, but it stays a listing and never opens a file.

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PathEntry } from "@toyon/shared";

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

/** Directories that could complete `raw`, repos first. A trailing slash lists the directory
 * itself; anything else treats the last segment as a prefix to match. */
export async function browsePath(raw: string): Promise<PathEntry[]> {
  const typed = expandTilde(raw.trim());
  if (!typed.startsWith("/")) return [];
  // "…/foo" means "entries of … starting with foo"; "…/" means "everything in …"
  const listing = typed.endsWith("/");
  const dir = listing ? typed : dirname(typed);
  const prefix = listing ? "" : typed.slice(dir.length).replace(/^\//, "").toLowerCase();

  let names: string[];
  try {
    const found = await readdir(dir, { withFileTypes: true });
    names = found.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);
  } catch {
    return []; // missing, unreadable or not a directory: nothing to offer, and no error worth a toast
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
  return entries.slice(0, MAX_ENTRIES);
}
