// Working-tree and branch state: porcelain parsing, line counts, changed ranges, ahead/behind.
// The parsers are pure; the functions around them shell out through git/exec.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GitFileStatus } from "@orchardist/shared";
import { GIT, git } from "./exec.ts";

export function statusFiles(worktreePath: string): GitFileStatus[] {
  // no trim: porcelain lines for unstaged changes start with a significant space
  const r = spawnSync(GIT, ["status", "--porcelain"], {
    cwd: worktreePath,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`git status failed: ${r.stderr}`);
  return parsePorcelain(r.stdout ?? "");
}

/** `git status --porcelain` (v1) → entries. Renames/copies (`R  old -> new`) report the NEW path:
 * that is the file that exists on disk, and what file-diff / discard act on. Quoted paths are unquoted. */
export function parsePorcelain(out: string): GitFileStatus[] {
  const unquote = (p: string) => (p.startsWith('"') && p.endsWith('"') ? JSON.parse(p) : p);
  return out
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => {
      const xy = line.slice(0, 2);
      const rest = line.slice(3);
      const arrow = xy.includes("R") || xy.includes("C") ? rest.lastIndexOf(" -> ") : -1;
      return { xy, path: unquote(arrow >= 0 ? rest.slice(arrow + 4) : rest) };
    });
}

/** File content at merge-base with the default branch (empty string for new files). */
export function fileBefore(worktreePath: string, defaultBr: string, file: string): string {
  const base = git(worktreePath, "merge-base", "HEAD", defaultBr);
  const ref = base.ok && base.out ? base.out : "HEAD";
  const r = git(worktreePath, "show", `${ref}:${file}`);
  return r.ok ? r.out : "";
}

type LineCounts = Pick<GitFileStatus, "add" | "del">;

/** `git diff --numstat` for the given range, keyed by path. Binary files map to {}. */
function numstat(worktreePath: string, ...range: string[]): Map<string, LineCounts> {
  const out = new Map<string, LineCounts>();
  const r = git(worktreePath, "diff", "--numstat", "--no-renames", ...range);
  if (!r.ok) return out;
  for (const line of r.out.split("\n")) {
    const [a, d, ...rest] = line.split("\t");
    const path = rest.join("\t").replace(/^"(.*)"$/, "$1");
    if (!path) continue;
    out.set(path, a === "-" || d === "-" ? {} : { add: Number(a), del: Number(d) });
  }
  return out;
}

/** Line count of an untracked file (all insertions). Undefined for binaries and directories. */
function untrackedLines(worktreePath: string, file: string): LineCounts {
  try {
    const buf = readFileSync(join(worktreePath, file));
    if (buf.subarray(0, 8000).includes(0)) return {};
    if (buf.length === 0) return { add: 0, del: 0 };
    let n = 0;
    for (const b of buf) if (b === 10) n++;
    if (buf[buf.length - 1] !== 10) n++;
    return { add: n, del: 0 };
  } catch {
    return {};
  }
}

/** Uncommitted files with +/- line counts vs HEAD (staged and unstaged combined). */
export function statusFilesWithCounts(worktreePath: string): GitFileStatus[] {
  const files = statusFiles(worktreePath);
  if (files.length === 0) return files;
  const counts = files.some((f) => f.xy !== "??") ? numstat(worktreePath, "HEAD") : new Map<string, LineCounts>();
  return files.map((f) => ({
    ...f,
    ...(f.xy === "??" ? untrackedLines(worktreePath, f.path) : (counts.get(f.path) ?? {})),
  }));
}

/** Files changed between merge-base with main and HEAD (committed, not yet landed). */
export function committedFiles(worktreePath: string, defaultBr: string): GitFileStatus[] {
  const base = git(worktreePath, "merge-base", "HEAD", defaultBr);
  if (!base.ok || !base.out) return [];
  const r = git(worktreePath, "diff", "--name-status", base.out, "HEAD");
  if (!r.ok || !r.out) return [];
  const counts = numstat(worktreePath, base.out, "HEAD");
  return r.out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split("\t");
      const path = rest[rest.length - 1] ?? "";
      return { xy: `${(status ?? "M").slice(0, 1)} `, path, ...(counts.get(path) ?? {}) };
    });
}

/** Changed line ranges (new-file numbering) for one file vs merge-base with main,
 * including uncommitted work. Untracked files return one open-ended range. */
export function changedRanges(worktreePath: string, defaultBr: string, file: string): Array<[number, number]> {
  const status = statusFiles(worktreePath).find((f) => f.path === file);
  if (status?.xy === "??") return [[1, 1_000_000]];
  const base = git(worktreePath, "merge-base", "HEAD", defaultBr);
  const ref = base.ok && base.out ? base.out : "HEAD";
  const r = git(worktreePath, "diff", "-U0", ref, "--", file);
  if (!r.ok) return [];
  const ranges: Array<[number, number]> = [];
  for (const m of r.out.matchAll(/^@@ [^+]*\+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count > 0) ranges.push([start, start + count - 1]);
  }
  return ranges;
}

export function aheadBehind(worktreePath: string, defaultBr: string): { ahead: number; behind: number } {
  const a = git(worktreePath, "rev-list", "--count", `${defaultBr}..HEAD`);
  const b = git(worktreePath, "rev-list", "--count", `HEAD..${defaultBr}`);
  return { ahead: Number(a.out) || 0, behind: Number(b.out) || 0 };
}
