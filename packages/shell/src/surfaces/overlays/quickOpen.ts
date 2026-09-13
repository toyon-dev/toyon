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
 * directory (`?? src/pages/`) counts as added with no line counts; deleted files are
 * gone from `git ls-files` so they come from the status list alone.
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
  const scored: Array<{ row: QuickOpenRow; score: number }> = [];
  for (const row of rows) {
    const lower = row.path.toLowerCase();
    let score = fuzzyScore(lower, needle);
    if (score <= 0) continue;
    if (fuzzyScore(lower.slice(lower.lastIndexOf("/") + 1), needle) > 0) score += 10;
    if (row.status) score += 4;
    scored.push({ row, score });
  }
  scored.sort((a, b) => b.score - a.score || a.row.path.localeCompare(b.row.path));
  return { rows: scored.slice(0, limit).map((x) => x.row), changed: 0 };
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
