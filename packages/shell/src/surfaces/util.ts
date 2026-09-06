import type { GitFileStatus, WorktreeStatus } from "@orchardist/shared";

/** Preview iframes hit the worktree's proxy port. Locally that is always loopback (the daemon
 * binds 127.0.0.1); in cloud mode the same port is a public TLS port on the host that served this
 * page, so follow the page's origin. */
export function previewUrl(proxyPort: number): string {
  const h = location.hostname;
  const local = h === "127.0.0.1" || h === "localhost" || h.endsWith(".localhost");
  if (local) return `http://127.0.0.1:${proxyPort}/`;
  return `${location.protocol}//${h}:${proxyPort}/`;
}

/** fiber lineNumbers may be preamble-shifted (daemon derives the offset per file) */
export function shiftRanges(cr: { ranges: Array<[number, number]>; offset: number }): Array<[number, number]> {
  return cr.ranges.map(([a, b]) => [a + cr.offset, b + cr.offset]);
}

/** a source path as the user thinks of it: relative to the worktree, else from `src/` */
export function relFile(file: string, worktreePath?: string): string {
  if (worktreePath && file.startsWith(`${worktreePath}/`)) return file.slice(worktreePath.length + 1);
  const i = file.lastIndexOf("/src/");
  return i >= 0 ? file.slice(i + 1) : file;
}

export function clampW(n: number, fallback: number): number {
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(n, 170), Math.floor(window.innerWidth * 0.5));
}

/** the rail dot: what the worktree is doing right now */
export function dotClass(w: WorktreeStatus): string {
  if (w.agent === "working") return "working";
  if (w.worktree.landed) return "landed";
  if (w.procs.some((p) => p.status === "crashed")) return "crashed";
  if (w.procs.some((p) => p.status === "running")) return "running";
  if (w.procs.some((p) => p.status === "starting")) return "starting";
  return "idle";
}

export function xyClass(xy: string): string {
  if (xy.includes("A") || xy === "??") return "added";
  if (xy.includes("D")) return "deleted";
  return "";
}

/** Porcelain XY → one letter. The tool commits with `add -A`, so staged vs unstaged is not a
 * distinction the user can act on, and untracked is just "new". */
export function xyLetter(xy: string): string {
  if (xy === "??") return "A";
  if (xy === "UU" || xy === "AA" || xy === "DD" || xy.includes("U")) return "C";
  const code = xy.trim()[0] ?? "";
  return code === "T" ? "M" : code || "·";
}

export type { GitFileStatus };

export const EDITORS: Array<{ label: string; scheme: string }> = [
  { label: "Zed", scheme: "zed" },
  { label: "VS Code", scheme: "vscode" },
  { label: "Cursor", scheme: "cursor" },
];
