// Working-tree and branch state: porcelain parsing, line counts, changed ranges, ahead/behind.
// The parsers are pure; the functions around them shell out through git/exec.

import { join } from "node:path";
import type { GitFileStatus } from "@toyon/shared";
import { git, gitRaw } from "./exec.ts";

/** The tree's content in one string: HEAD, a hash of the whole diff against it, and a hash of
 * each untracked file. A landing verdict is written against this and retired when it no longer
 * matches. Exact, since the verdict and the message were written about these bytes, and cheap
 * enough to take on every status read: the diff is what the changes panel already draws. */
export async function treeFingerprint(worktreePath: string): Promise<string> {
  const [head, diff, untracked] = await Promise.all([
    git(worktreePath, "rev-parse", "HEAD"),
    gitRaw(worktreePath, "diff", "HEAD", "--no-renames"),
    git(worktreePath, "ls-files", "--others", "--exclude-standard"),
  ]);
  const others = await Promise.all(
    untracked.out
      .split("\n")
      .filter(Boolean)
      .map(async (p) => {
        try {
          const f = Bun.file(join(worktreePath, p));
          // a dumped database or a video is its size, not its bytes
          const body = f.size > 2_000_000 ? String(f.size) : Bun.hash(await f.arrayBuffer()).toString(36);
          return `${p}:${body}`;
        } catch {
          // gone between the listing and the read: its absence is the fact
          return `${p}:-`;
        }
      }),
  );
  return `${head.out}:${Bun.hash(diff.out).toString(36)}:${Bun.hash(others.join("\n")).toString(36)}`;
}

/** `only` narrows the status to those exact paths: a question about one file should not walk the tree */
export async function statusFiles(worktreePath: string, ...only: string[]): Promise<GitFileStatus[]> {
  // -uall, because the default collapses a wholly-untracked directory into a single `dir/` entry:
  // not a path the panel can diff, count lines for, or discard. .gitignore still applies, so the
  // set of files this adds is the set a commit would have taken anyway. Literal pathspecs, so a
  // file named with a `*` is that file and not a glob.
  const args = ["status", "--porcelain", "-uall"];
  const r = only.length
    ? await gitRaw(worktreePath, "--literal-pathspecs", ...args, "--", ...only)
    : await gitRaw(worktreePath, ...args);
  if (!r.ok) throw new Error(`git status failed: ${r.err}`);
  return parsePorcelain(r.out);
}

/** `git status --porcelain` (v1) → entries. Renames/copies (`R  old -> new`) report the NEW path:
 * that is the file that exists on disk, and what read-file / discard act on. Quoted paths are unquoted. */
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
export async function fileBefore(worktreePath: string, defaultBr: string, file: string): Promise<string> {
  const base = await git(worktreePath, "merge-base", "HEAD", defaultBr);
  const ref = base.ok && base.out ? base.out : "HEAD";
  // untrimmed: the editor compares this against the file on disk, and a trimmed final newline drew
  // an added empty line at the end of every diff, and one on a file with no changes at all
  const r = await gitRaw(worktreePath, "show", `${ref}:${file}`);
  return r.ok ? r.out : "";
}

export type LineCounts = Pick<GitFileStatus, "add" | "del">;

/** `--numstat` output → counts by path, whichever command produced it. Binary files map to {}. */
export function parseNumstat(out: string): Map<string, LineCounts> {
  const counts = new Map<string, LineCounts>();
  for (const line of out.split("\n")) {
    const [a, d, ...rest] = line.split("\t");
    const path = rest.join("\t").replace(/^"(.*)"$/, "$1");
    if (!path) continue;
    counts.set(path, a === "-" || d === "-" ? {} : { add: Number(a), del: Number(d) });
  }
  return counts;
}

/** `git diff --numstat` for the given range, keyed by path. */
async function numstat(worktreePath: string, ...range: string[]): Promise<Map<string, LineCounts>> {
  const r = await git(worktreePath, "diff", "--numstat", "--no-renames", ...range);
  return r.ok ? parseNumstat(r.out) : new Map<string, LineCounts>();
}

/** Line count of an untracked file (all insertions). Undefined for binaries and directories. */
async function untrackedLines(worktreePath: string, file: string): Promise<LineCounts> {
  try {
    const f = Bun.file(join(worktreePath, file));
    // a dumped database or a video is not something to count lines in
    if (f.size > 2_000_000) return {};
    const buf = new Uint8Array(await f.arrayBuffer());
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
export async function statusFilesWithCounts(worktreePath: string): Promise<GitFileStatus[]> {
  const files = await statusFiles(worktreePath);
  if (files.length === 0) return files;
  const counts = files.some((f) => f.xy !== "??") ? await numstat(worktreePath, "HEAD") : new Map<string, LineCounts>();
  return Promise.all(
    files.map(async (f) => ({
      ...f,
      ...(f.xy === "??" ? await untrackedLines(worktreePath, f.path) : (counts.get(f.path) ?? {})),
    })),
  );
}

/** Files changed between merge-base with main and HEAD (committed, not yet landed). */
export async function committedFiles(worktreePath: string, defaultBr: string): Promise<GitFileStatus[]> {
  const base = await git(worktreePath, "merge-base", "HEAD", defaultBr);
  if (!base.ok || !base.out) return [];
  const r = await git(worktreePath, "diff", "--name-status", base.out, "HEAD");
  if (!r.ok || !r.out) return [];
  const counts = await numstat(worktreePath, base.out, "HEAD");
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
export async function changedRanges(
  worktreePath: string,
  defaultBr: string,
  file: string,
): Promise<Array<[number, number]>> {
  const status = (await statusFiles(worktreePath, file)).find((f) => f.path === file);
  if (status?.xy === "??") return [[1, 1_000_000]];
  const base = await git(worktreePath, "merge-base", "HEAD", defaultBr);
  const ref = base.ok && base.out ? base.out : "HEAD";
  const r = await git(worktreePath, "diff", "-U0", ref, "--", file);
  if (!r.ok) return [];
  const ranges: Array<[number, number]> = [];
  for (const m of r.out.matchAll(/^@@ [^+]*\+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count > 0) ranges.push([start, start + count - 1]);
  }
  return ranges;
}

/** nothing tracked at HEAD. Asked only after `git status` came back empty, so this is the one
 * call that separates a clean tree from a repo with nothing in it yet. Non-recursive on purpose:
 * a real project lists its top level and stops there. An unborn HEAD fails the call, and that
 * repo is empty too. */
export async function treeEmpty(worktreePath: string): Promise<boolean> {
  const r = await git(worktreePath, "ls-tree", "--name-only", "HEAD");
  return !r.ok || r.out === "";
}

/** whether git holds `rel` in the index: a file the team has, as opposed to one only on disk */
export async function isTracked(worktreePath: string, rel: string): Promise<boolean> {
  return (await git(worktreePath, "ls-files", "--error-unmatch", "--", rel)).ok;
}

/** how far HEAD trails its upstream as of the last fetch; null when the branch has none */
export async function behindUpstream(worktreePath: string): Promise<number | null> {
  const r = await git(worktreePath, "rev-list", "--count", "HEAD..@{upstream}");
  return r.ok ? Number(r.out) || 0 : null;
}

export async function aheadBehind(worktreePath: string, defaultBr: string): Promise<{ ahead: number; behind: number }> {
  const [a, b] = await Promise.all([
    git(worktreePath, "rev-list", "--count", `${defaultBr}..HEAD`),
    git(worktreePath, "rev-list", "--count", `HEAD..${defaultBr}`),
  ]);
  return { ahead: Number(a.out) || 0, behind: Number(b.out) || 0 };
}
