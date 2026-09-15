import type { GitFileStatus } from "@toyon/shared";

/** One ⌘P row: the path plus its uncommitted status, if any. */
export interface QuickOpenRow {
  path: string;
  status?: GitFileStatus;
}

export interface QuickOpenList {
  rows: QuickOpenRow[];
  /** number of leading rows that are uncommitted changes; a divider goes after them (empty query only) */
  changed: number;
}

/**
 * Attach uncommitted status to the worktree's file list. A file inside an untracked
 * directory (`?? src/pages/`) counts as added with no line counts; a deleted file is not
 * in the list, which is what is on disk, so it comes from the status list alone.
 */
export function withStatus(paths: string[], status: GitFileStatus[]): QuickOpenRow[] {
  const exact = new Map(status.map((s) => [s.path, s]));
  const dirs = status.filter((s) => s.xy === "??" && s.path.endsWith("/")).map((s) => s.path);
  const rows: QuickOpenRow[] = paths.map((path) => {
    const s = exact.get(path) ?? (dirs.some((d) => path.startsWith(d)) ? { path, xy: "??" } : undefined);
    return s ? { path, status: s } : { path };
  });
  const listed = new Set(paths);
  for (const s of status) if (!listed.has(s.path) && !s.path.endsWith("/")) rows.push({ path: s.path, status: s });
  return rows;
}

/**
 * Empty query: changed files first in status order (same as the changes panel), then the
 * rest alphabetically. With a query: fuzzy score, basename hits preferred, a small nudge
 * for changed files so ties break toward what the agent just touched.
 */
export function rankFiles(paths: string[], status: GitFileStatus[], query: string, limit = 50): QuickOpenList {
  const rows = withStatus(paths, status);
  const needle = query.trim().toLowerCase();
  if (!needle) {
    const order = new Map(status.map((s, i) => [s.path, i]));
    const rank = (r: QuickOpenRow) => order.get(r.status?.path ?? "") ?? order.get(r.path) ?? Number.MAX_SAFE_INTEGER;
    const changed = rows.filter((r) => r.status).sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
    const rest = rows.filter((r) => !r.status).sort((a, b) => a.path.localeCompare(b.path));
    return { rows: [...changed, ...rest].slice(0, limit), changed: Math.min(changed.length, limit) };
  }
  const scored = scoreFiles(rows, needle);
  scored.sort((a, b) => b.score - a.score || a.row.path.localeCompare(b.row.path));
  return { rows: scored.slice(0, limit).map((x) => x.row), changed: 0 };
}

/** fuzzy over the whole path, with a bump when the last segment alone matches; 0 for no match */
function scorePath(path: string, needle: string): number {
  const lower = path.toLowerCase();
  const score = fuzzyScore(lower, needle);
  if (score <= 0) return 0;
  return fuzzyScore(lower.slice(lower.lastIndexOf("/") + 1), needle) > 0 ? score + 10 : score;
}

function scoreFiles(rows: QuickOpenRow[], needle: string): Array<{ row: QuickOpenRow; score: number }> {
  const scored: Array<{ row: QuickOpenRow; score: number }> = [];
  for (const row of rows) {
    const score = scorePath(row.path, needle);
    if (score > 0) scored.push({ row, score: row.status ? score + 4 : score });
  }
  return scored;
}

/** one row of the composer's @ menu: a file, or a folder the files imply */
export type MentionRow = { kind: "file"; path: string; status?: GitFileStatus } | { kind: "folder"; path: string };

/**
 * The @ menu's rows. Files rank as ⌘P ranks them; with a query, the folders that match rank beside
 * them, a folder below a file that matches as well, or `@src` would fill up with folders. An empty
 * query lists files only, since every folder matches it.
 */
export function rankMentions(
  paths: string[],
  folders: string[],
  status: GitFileStatus[],
  query: string,
  limit: number,
): MentionRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle)
    return rankFiles(paths, status, query, limit).rows.map((r) => ({ kind: "file", path: r.path, status: r.status }));
  const scored: Array<{ row: MentionRow; score: number }> = scoreFiles(withStatus(paths, status), needle).map(
    ({ row, score }) => ({ row: { kind: "file", path: row.path, status: row.status }, score }),
  );
  for (const path of folders) {
    const score = scorePath(path, needle);
    if (score > 0) scored.push({ row: { kind: "folder", path }, score });
  }
  const folderLast = (r: MentionRow) => (r.kind === "folder" ? 1 : 0);
  scored.sort(
    (a, b) => b.score - a.score || folderLast(a.row) - folderLast(b.row) || a.row.path.localeCompare(b.row.path),
  );
  return scored.slice(0, limit).map((x) => x.row);
}

/** positions the greedy subsequence walk in fuzzyScore lands on, for highlighting; null when no match */
export function matchPositions(hay: string, needle: string): number[] | null {
  const lower = hay.toLowerCase(),
    out: number[] = [];
  let hi = 0;
  for (const ch of needle.toLowerCase()) {
    const found = lower.indexOf(ch, hi);
    if (found === -1) return null;
    out.push(found);
    hi = found + 1;
  }
  return out;
}

/** subsequence match; bonuses for consecutive hits and path-segment starts */
export function fuzzyScore(hay: string, needle: string): number {
  let score = 0,
    hi = 0,
    streak = 0;
  for (const ch of needle) {
    const found = hay.indexOf(ch, hi);
    if (found === -1) return 0;
    streak = found === hi ? streak + 1 : 1;
    score += streak + (found === 0 || hay[found - 1] === "/" || hay[found - 1] === "." ? 3 : 0);
    hi = found + 1;
  }
  return score + Math.max(0, 40 - hay.length / 4);
}

/** "src/pages/About.tsx" → ["About.tsx", "src/pages/"]; root files have an empty dir */
export function splitPath(path: string): [name: string, dir: string] {
  const i = path.lastIndexOf("/");
  return i === -1 ? [path, ""] : [path.slice(i + 1), path.slice(0, i + 1)];
}
