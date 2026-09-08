import { type ChordId, chordLabel, type ProcState, type WorktreeInfo, type WorktreeStatus } from "@toyon/shared";

/** Preview iframes hit the worktree's proxy port. Locally that is always loopback (the daemon
 * binds 127.0.0.1); in cloud mode the same port is a public TLS port on the host that served this
 * page, so follow the page's origin.
 *
 * The host matters as much as the port. "Same site" is scheme + registrable domain and ignores
 * the port, so a preview served from `<id>.toyon.localhost` lands on the shell's own site and its
 * cookies stop counting as third-party. That is what makes cookie login work inside the iframe:
 * Safari blocks third-party cookies unconditionally, and Chrome does whenever the setting is on.
 * The per-worktree label earns its keep too, because cookies ignore the port: one shared host
 * would mean one shared jar, and two worktrees running the same app would stomp each other's
 * session.
 *
 * Only a shell already served from a *.localhost name can do this. From bare `localhost`,
 * `<id>.localhost` is its own registrable domain and would be cross-site anyway, so stay on
 * loopback there rather than pretend. */
export function previewUrl(worktreeId: string, proxyPort: number): string {
  const h = location.hostname;
  if (h.endsWith(".localhost")) return `http://w${worktreeId}.${h}:${proxyPort}/`;
  if (h === "127.0.0.1" || h === "localhost") return `http://127.0.0.1:${proxyPort}/`;
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

/** what the composer's terminal badge says. Only "crashed" counts as trouble: "stopped" is a
 * clean exit or one you killed in the proc's own tab, and "starting" resolves on its own. */
export interface ProcTrouble {
  /** the crashed procs, in config order */
  dead: ProcState[];
  /** tooltip: what died and what a click does */
  tip: string;
  /** the tab a click should land on */
  stream: string;
}

export function procTrouble(procs: ProcState[]): ProcTrouble | null {
  const dead = procs.filter((p) => p.status === "crashed");
  const first = dead[0];
  if (!first) return null;
  const what = dead.map((p) => `${p.name} crashed on :${p.port}`).join(", ");
  return { dead, tip: `${what} · click to open its tab`, stream: first.name };
}

/** a changed file split for display: the name leads, the directory trails it dimmed. The name is
 * what you scan a list of changes for, and putting it first also means the part that overflows a
 * narrow dock is the part you can afford to lose. */
export function splitPath(path: string): { name: string; dir: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { name: path, dir: "" } : { name: path.slice(i + 1), dir: path.slice(0, i) };
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

// Firefox owns ⌘⇧P (new private window) before the page sees it; both chords work everywhere
// else, so advertise the one that will actually fire in this browser. The reverse for ⌘N: only
// an installed Chromium PWA hands it to the page (browser tabs, Safari and Firefox take it as
// new window), so only there is it advertised over ⌘K.
const IS_FIREFOX = /Firefox\//.test(navigator.userAgent);

/** running as an installed app. The manifest asks for window-controls-overlay, and when Chrome
 * grants it `display-mode: standalone` is false, so both modes count. */
export function isInstalledApp(): boolean {
  const mq = (q: string) => window.matchMedia?.(`(display-mode: ${q})`).matches ?? false;
  return mq("standalone") || mq("window-controls-overlay");
}

const IS_CHROMIUM_PWA = /Chrome\//.test(navigator.userAgent) && isInstalledApp();
export const chord = (id: ChordId) => chordLabel(id, { firefox: IS_FIREFOX, pwa: IS_CHROMIUM_PWA });

/** the picked element as a label: <Component> or <tag> */
export function pickLabel(p: { component: string | null; tag: string }): string {
  return p.component ? `<${p.component}>` : `<${p.tag}>`;
}

/** the path to show people for a worktree: the title-named link when the directory itself is a
 * claimed spare's, else the directory (git and the procs always use `path`) */
export const wtDir = (w: WorktreeInfo) => w.linkPath ?? w.path;
