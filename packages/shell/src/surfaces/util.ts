import {
  type ChordId,
  chordLabel,
  isMain,
  isOwned,
  type ProcState,
  previewOrigin,
  type RemoteView,
  type RepoInfo,
  type WorktreeInfo,
  type WorktreeStatus,
} from "@toyon/shared";

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
 * loopback there rather than pretend.
 *
 * A shell served from the public name (hello's `remote`) came through a TLS front, and the daemon
 * says where previews live under it. Routed by name, every preview rides the front's one port
 * under its own label: same site as the shell again, for the same reasons. On their own ports the
 * front holds no wildcard certificate: still same site, but one cookie jar for every worktree. */
export function previewUrl(worktreeId: string, proxyPort: number, remote: RemoteView | null): string {
  const h = location.hostname;
  if (remote !== null && h === remote.host) return `${previewOrigin(remote.previews, worktreeId, proxyPort)}/`;
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

/** a dock's width as dragged: never under the row's floor (--dock-min in app.css, the same 170),
 * never over half the window */
export function clampW(n: number, fallback: number): number {
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(n, 170), Math.floor(window.innerWidth * 0.5));
}

/** the rail dot: what the worktree is doing right now */
/** the agent is doing something, or waiting for you to let it carry on. Several places mean this
 * rather than "working" specifically, and a blocked worktree that reads as idle is the worst of
 * the two mistakes: it is the one that needs you. */
export function isBusy(w: WorktreeStatus): boolean {
  return w.agent === "working" || w.agent === "waiting";
}

export type DotState =
  | "waiting"
  | "working"
  | "failed"
  | "landed"
  | "crashed"
  | "running"
  | "starting"
  | "asleep"
  | "idle";

export function dotClass(w: WorktreeStatus): DotState {
  // a worktree that needs you outranks one that is merely busy
  if (w.agent === "waiting") return "waiting";
  if (w.agent === "working") return "working";
  // a turn that stopped on an error needs a person until the next one starts. The record outlives
  // the process and the daemon, which only the status does not; without it a server still running
  // underneath paints the row green, the colour of work going fine.
  if (w.agent === "error" || w.worktree?.lastTurn?.end === "failed") return "failed";
  if (w.worktree?.landed) return "landed";
  // unreachable wears the crashed colour: alive, but nothing to show, and it needs a person
  if (w.procs.some((p) => p.status === "crashed" || p.status === "unreachable")) return "crashed";
  if (w.procs.some((p) => p.status === "running")) return "running";
  if (w.procs.some((p) => p.status === "starting")) return "starting";
  // stopped by toyon because nobody was looking; it comes back when someone does
  if (w.procs.some((p) => p.status === "asleep")) return "asleep";
  return "idle";
}

const DOT_LABEL: Record<DotState, string> = {
  waiting: "Waiting for you",
  working: "Agent working",
  failed: "Agent failed",
  landed: "Landed",
  crashed: "Crashed",
  running: "Running",
  starting: "Starting",
  asleep: "Asleep",
  idle: "Idle",
};

/** the dot in words, for the row's tooltip. An idle dot on a repo that has no confirmed config is
 * the one state the colour cannot explain: nothing runs there because nothing was told to. */
export function stateLabel(w: WorktreeStatus, needsSetup = false): string {
  const d = dotClass(w);
  return d === "idle" && needsSetup ? "Not set up" : DOT_LABEL[d];
}

/** what the composer's terminal badge says. "crashed" and "unreachable" count as trouble:
 * "stopped" is a clean exit or one you killed in the proc's own tab, and "starting" resolves on
 * its own (or turns into unreachable, which is when it becomes trouble). */
export interface ProcTrouble {
  /** the crashed or unreachable procs, in config order */
  dead: ProcState[];
  /** tooltip: what is wrong and what a click does */
  tip: string;
  /** the tab a click should land on */
  stream: string;
}

export function procTrouble(procs: ProcState[]): ProcTrouble | null {
  const dead = procs.filter((p) => p.status === "crashed" || p.status === "unreachable");
  const first = dead[0];
  if (!first) return null;
  const what = dead
    .map((p) =>
      p.status === "unreachable" ? `${p.name} never answered on :${p.port}` : `${p.name} crashed on :${p.port}`,
    )
    .join(", ");
  return { dead, tip: `${what} · click to open its tab`, stream: first.name };
}

/** a changed file split for display: the name leads, the directory trails it dimmed. The name is
 * what you scan a list of changes for, and putting it first also means the part that overflows a
 * narrow dock is the part you can afford to lose. */
export function splitPath(path: string): { name: string; dir: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { name: path, dir: "" } : { name: path.slice(i + 1), dir: path.slice(0, i) };
}

/** file2 before file10, and case no reason to separate two names: how a list of paths is ordered
 * wherever one is shown */
export const naturalCompare = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare;

/** the folders a path sits in, outermost first: "a/b/c.ts" is in "a" and "a/b" */
export function ancestors(path: string): string[] {
  const out: string[] = [];
  for (let i = path.indexOf("/"); i !== -1; i = path.indexOf("/", i + 1)) out.push(path.slice(0, i));
  return out;
}

/** every folder a list of paths implies, sorted. The files tab and the composer's `@` menu read it
 * from the same file list, so they agree on which folders exist. */
export function folderList(paths: readonly string[]): string[] {
  const set = new Set<string>();
  for (const p of paths) for (const a of ancestors(p)) set.add(a);
  return [...set].sort(naturalCompare);
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
  // globalThis, so a menu built under a test with no window reads as a browser tab
  const mq = (q: string) => globalThis.matchMedia?.(`(display-mode: ${q})`).matches ?? false;
  return mq("standalone") || mq("window-controls-overlay");
}

const IS_CHROMIUM_PWA = /Chrome\//.test(navigator.userAgent) && isInstalledApp();
export const chord = (id: ChordId) => chordLabel(id, { firefox: IS_FIREFOX, pwa: IS_CHROMIUM_PWA });

/** the picked element as a label: <Component /> or <tag>, the way the prompt names it too */
export function pickLabel(p: { component: string | null; tag: string }): string {
  return p.component ? `<${p.component} />` : `<${p.tag}>`;
}

/** the path to show people for a worktree: the title-named link when the directory itself is a
 * claimed spare's, else the directory (git and the procs always use `path`) */
export const wtDir = (w: WorktreeInfo) => w.linkPath ?? w.path;

/** what a worktree row is called: main by its branch (main, master, trunk), since it is the base
 * every other row branches from and the project's own name is already on the pill; every other
 * row by its title */
export function rowLabel(w: WorktreeStatus, repo: RepoInfo | null): string {
  return w.worktree && isMain(w.worktree) && repo ? repo.defaultBranch : w.name;
}

/** Coarse on purpose: the question an age in a row answers is "how long ago", and a narrow row has
 * no space for a date the reader would have to parse anyway. */
export function ago(at: number): string {
  const secs = Math.max(0, (Date.now() - at) / 1000);
  if (secs < 60) return "now";
  const mins = secs / 60;
  if (mins < 60) return `${Math.floor(mins)}m`;
  const hours = mins / 60;
  if (hours < 24) return `${Math.floor(hours)}h`;
  const days = hours / 24;
  if (days < 7) return `${Math.floor(days)}d`;
  if (days < 365) return `${Math.floor(days / 7)}w`;
  return `${Math.floor(days / 365)}y`;
}

/** Whose advertised slash commands stand in for a session that does not exist yet.
 *
 * ⌘K opens before there is a worktree, so it has no session to ask, but it does not need its own:
 * commands come from the repo's settings, skills and MCP servers, so every worktree of a repo
 * running the same agent advertises the same list, and the one ⌘K is about to create will too.
 * Main first, because it exists from the moment the repo is registered and is the likeliest to
 * have run. An agent the person switched to but has never started anywhere yet has no stand-in,
 * and the menu says so rather than showing another agent's commands.
 *
 * A worktree carries no `agent` until its session first spawns, when the daemon stamps it with the
 * default: unstamped therefore reads as the default here too, or main would never match before it
 * had run, which is exactly when the menu needs to find it and start it. */
export function commandSource(
  rows: WorktreeStatus[],
  repoId: string | undefined,
  agent: string,
  defaultAgent: string,
): string | null {
  if (!repoId) return null;
  // only a worktree toyon runs has a session to ask
  const mine = rows.filter(isOwned).filter((w) => w.repoId === repoId && (w.worktree.agent ?? defaultAgent) === agent);
  const main = mine.find((w) => isMain(w.worktree));
  return (main ?? mine[0])?.id ?? null;
}
