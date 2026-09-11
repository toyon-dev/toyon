// Shell state: one reducer over slices. Pure — no window/localStorage reads in here; main.tsx
// builds the initial state from the browser and passes it in (initialState), which is also why the
// reducer is testable.

import type {
  AgentCommand,
  AgentConfigInfo,
  AgentEvent,
  AgentInfo,
  AskAnswer,
  AskChoice,
  AskOutcome,
  AskQuestion,
  AuthMethodInfo,
  CommitEntry,
  ConnectFailure,
  DesignIndex,
  FileServerMsg,
  GitFileStatus,
  ImageInput,
  ImageRef,
  LogLine,
  OwnedWorktree,
  PasteInput,
  PasteRef,
  PathEntry,
  PathTarget,
  PendingRepo,
  PickedElement,
  PickMeta,
  PickVerb,
  RefHit,
  RepoInfo,
  SearchHit,
  ServerMsg,
  SpareInfo,
  TermServerMsg,
  Theme,
  ThemePrefs,
  ToolKind,
  WorktreeStatus,
} from "@toyon/shared";
import {
  builtinThemes,
  defaultThemePrefs,
  isEditTool,
  isMain,
  isOwned,
  resolveTheme,
  SHELL_STREAM,
  toyonDark,
} from "@toyon/shared";

export type UsageFigures = { used: number; size: number; cost?: number };

export type ChatItem =
  | { kind: "user"; text: string; pick?: PickMeta; images?: ImageRef[]; pastes?: PasteRef[] }
  | { kind: "assistant"; text: string }
  | { kind: "thinking"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      input: unknown;
      output?: string;
      isError?: boolean;
      done: boolean;
      toolKind?: ToolKind;
      title?: string;
      /** the call that spawned this one, when the agent said so: the row indents under it */
      parentToolId?: string;
      /** this call is the spawn itself (a Task), so its children have somewhere to sit */
      subagent?: boolean;
    }
  | { kind: "error"; text: string }
  | { kind: "blocked"; tool: string; path: string; reason: string }
  /** a divider: what follows was said in another worktree, grafted in here */
  | { kind: "grafted"; title: string; branch: string }
  /** the agent wants credentials; `done` once a login went through. `rejected`: it had a
   * credential and the provider refused it, so the error above this card says what went wrong */
  | {
      kind: "auth";
      agent: string;
      agentName: string;
      methods: AuthMethodInfo[];
      rejected?: boolean;
      done: boolean;
    }
  /** the agent asked something and is blocked until this is answered; `outcome` is what closed it,
   * and its absence is what "still open" means, including after a reload */
  | {
      kind: "ask";
      id: string;
      ask:
        | { kind: "question"; message: string; questions: AskQuestion[] }
        | { kind: "permission"; title: string; detail?: string; choices: AskChoice[] };
      outcome?: AskOutcome;
      answers?: AskAnswer[];
      choiceId?: string;
    };

export interface GitInfo {
  files: GitFileStatus[];
  committed?: GitFileStatus[];
  ahead?: number;
  behind?: number;
  /** HEAD's sha; the history tab re-reads its log when this moves */
  head?: string;
}

/** where up-arrow has walked the composer back to (surfaces/chat/recall.ts) */
export interface ComposerWalk {
  /** the sent entry's index in the chat, which is also the transcript row that is marked */
  at: number;
  /** what the box held when the walk began: nothing, or the `!` that asked for commands only */
  from: string;
}

/** everything the shell tracks for one worktree; dropped when the worktree disappears */
export interface WorktreeLocal {
  chat: ChatItem[];
  log: LogLine[];
  git?: GitInfo;
  /** quick-open listing (requested on ⌘P) */
  files?: string[];
  queue: string[];
  /** live page state (route, title, recent errors) — ambient chat context */
  page: { url?: string; title?: string; errors: string[] };
  /** did the current agent turn edit anything / did the page HMR */
  turn: { edits: boolean; hmr: boolean };
  /** changed line ranges cache by path (post-offset numbering from the daemon) */
  changedRanges: Record<string, { ranges: Array<[number, number]>; offset: number }>;
  /** the history tab's commit list; undefined until that tab has been opened once */
  commits?: CommitEntry[];
  /** files by commit sha, filled in as commits are expanded */
  commitFiles: Record<string, GitFileStatus[]>;
  /** ⌘⇧F results */
  search: { query: string; hits: SearchHit[]; truncated: boolean } | null;
  /** the design pane's last scan; null until it has been opened once for this worktree */
  design: DesignIndex | null;
  /** the composer's unsent text; survives switching worktrees, and is where the daemon's
   * conflict-resolution suggestion lands */
  draft: string;
  /** set while up and down are walking the composer back through what was sent, with `draft`
   * holding the entry walked to. Any other write to the draft ends it: a keystroke, a suggestion. */
  walk?: ComposerWalk;
  /** images pasted or dropped on the composer, not yet sent; `key` is local (the daemon numbers
   * them on send) */
  images: PendingImage[];
  /** long text pasted on the composer, not yet sent; `key` is local (the daemon numbers them on
   * send, like images) */
  pastes: PendingPaste[];
  /** the slash commands this worktree's agent advertises; empty until it has run once */
  commands: AgentCommand[];
  /** which stream the terminal pane is showing for this worktree: its shell or one of its procs.
   * Per worktree so switching back lands on the tab you left, and in the store so the rail can
   * open a crashed proc's tab. */
  termStream: string;
  /** the model and effort the agent reported running here, from the last session-info; absent
   * until one */
  model?: string;
  /** the agent's last figures here: context in use of the window, and the session's spend when
   * the agent prices itself. Drawn as the ring by the composer; never a row in the chat. */
  usage?: UsageFigures;
  effort?: string;
}

/** The new worktree being drafted: a tab in the rail for a worktree that does not exist yet, with
 * the base it will branch from. While it is open the base is the active row, so the left dock,
 * the terminal and ⌘1-9 keep meaning it; only the rail's mark, the centre frame and the chat dock
 * read this. Its text and attachments live in `local` under `draftKey(repoId)`. */
export interface Draft {
  base: string;
  /** the same prompt in N parallel worktrees, keep the best */
  variants: 1 | 2 | 3;
  /** an agent splits the prompt into a worktree per task instead */
  batch: boolean;
  /** the agent that works on it: the daemon's default when the tab opens; a draft from a task
   * inherits that task's agent whatever this says */
  agent: string;
  /** one of the repo's profiles; the repo's default when absent */
  profile?: string;
}

/** the `local` record a repo's draft is written under; never a row id, and never pruned by one */
const DRAFT_PREFIX = "draft:";
export const draftKey = (repoId: string) => DRAFT_PREFIX + repoId;

/** the composer box the words are written in: while drafting it is the repo's draft, so it survives
 * the tab closing and reopening and is never a row's; otherwise it is the active worktree's */
export const composerBoxOf = (active: OwnedWorktree | null, drafting: boolean): string | null =>
  active ? (drafting ? draftKey(active.worktree.repoId) : active.worktree.id) : null;

export interface PendingImage extends ImageInput {
  key: string;
  bytes: number;
}

export interface PendingPaste extends PasteInput {
  key: string;
  chars: number;
  lines: number;
  preview: string;
}

export const EMPTY_LOCAL: WorktreeLocal = Object.freeze({
  chat: [],
  log: [],
  queue: [],
  page: { errors: [] },
  turn: { edits: false, hmr: false },
  changedRanges: {},
  commitFiles: {},
  search: null,
  design: null,
  draft: "",
  images: [],
  pastes: [],
  commands: [],
  termStream: SHELL_STREAM,
}) as WorktreeLocal;

/** the modal overlays are mutually exclusive: exactly one (or none) is open */
export type Overlay =
  | { kind: "quick-open" }
  | { kind: "commands" }
  | { kind: "search" }
  /** the ref palette: a branch or PR to open as a worktree */
  | { kind: "refs" }
  | { kind: "keys" }
  /** theme picker: which pref slot Enter writes */
  | { kind: "theme"; slot: "theme" | "light" | "dark" }
  | { kind: "appearance" }
  /** default-agent picker */
  | { kind: "agent" }
  /** one agent's page in settings: who it is, the files it reads, the MCP servers it loads */
  | { kind: "agent-page"; agent: string }
  /** the setup pane for a repo that is already configured (install + start commands) */
  | { kind: "setup"; repoId: string }
  /** the project switcher: pick a registered repo, or type a path to open another. It hangs off
   * the pill in the bar; `dialog` is the roomier centered form its browse button opens. */
  | { kind: "projects"; dialog?: boolean }
  /** the new-project form, carrying whatever the picker row already knew. `create` needs a name and
   * a location; `clone` has both derived from the URL and shows them so they can be changed. */
  | { kind: "new-project"; mode: "create" | "clone"; name: string; parent: string; url?: string }
  /** the route bar's list of pages, opened over the address field */
  | { kind: "routes" };

/** which docks and panes a project is left with. The layout is remembered per project, so a reload
 * comes back to it and switching projects carries each one's own back (zen is deliberately not in
 * here: it is a mode you leave, not a layout). */
export interface Panels {
  left: boolean;
  right: boolean;
  term: boolean;
  design: boolean;
}

/** what a project that has never been laid out gets: the docks open, the panes shut */
export const defaultPanels: Panels = Object.freeze({ left: true, right: true, term: false, design: false });

function panelsOf(s: State): Panels {
  return { left: s.leftOpen, right: s.rightOpen, term: s.termOpen, design: s.designOpen };
}

function samePanels(a: Panels, b: Panels): boolean {
  return a.left === b.left && a.right === b.right && a.term === b.term && a.design === b.design;
}

function applyPanels(s: State, p: Panels): State {
  // a remembered layout is a decision, so the clean-main auto-close must not second-guess it
  return { ...s, leftOpen: p.left, rightOpen: p.right, termOpen: p.term, designOpen: p.design, leftAuto: false };
}

/** what the editor pane draws for its file: the diff against main, or the file with none over it */
export type EditorView = "diff" | "file";

/** the file as the editor last read or saved it */
export interface EditorDisk {
  before: string;
  after: string;
  /** names the bytes on disk; a save names it back as the version it replaces */
  version: string | null;
  writable: boolean;
  binary: boolean;
  tooLarge: boolean;
}

/** A jump to a line once the file shows. `fiber` is a line the running page reported, counted
 * against the served module rather than the file, which the changed-ranges offset maps back. */
export interface EditorLine {
  n: number;
  fiber?: boolean;
}

/** what a caller opens */
export interface OpenFile {
  worktreeId: string;
  path: string;
  /** a commit's copy: history, so the editor opens it read-only */
  ref?: string;
  view?: EditorView;
  line?: EditorLine;
  /** the keyboard follows the file into the editor */
  focus: boolean;
  /** names this open: a line to reveal and the keyboard are handed over once per open */
  seq: number;
}

/** a file the editor can have open: a working-tree path, or a commit's copy of one */
export type FileRef = Pick<OpenFile, "worktreeId" | "path" | "ref">;

export const sameFile = (a: FileRef, b: FileRef) =>
  a.worktreeId === b.worktreeId && a.path === b.path && a.ref === b.ref;

/** The file the editor pane has open. The pane shows it before the daemon has read it; fileSync
 * reads it and keeps what the pane shows in step with the disk. */
export interface EditorFile extends Omit<OpenFile, "view"> {
  /** null until the first read decides: a changed file opens on its diff, an unchanged one as the file */
  view: EditorView | null;
  /** null while the first read is out */
  disk: EditorDisk | null;
  /** the file changed on disk under unsaved edits: what is there now, until reload or keep mine settles it */
  conflict: { after: string; version: string | null } | null;
}

/** a line the page reported, mapped back to the file once the offset for its path is known */
function placeLine(s: State, worktreeId: string, path: string, line: EditorLine): EditorLine {
  if (!line.fiber) return line;
  const offset = localOf(s, worktreeId).changedRanges[path]?.offset;
  return offset === undefined ? line : { n: line.n - offset };
}

export interface State {
  connected: boolean;
  /** why the socket is down, once the shell has worked it out; null while connected or still probing */
  connectFailure: ConnectFailure | null;
  repos: RepoInfo[];
  /** every row the daemon lists, in its order: toyon's own worktrees, then the ones git knows
   * about that toyon did not create. One array, as it arrives; the two views below split it. */
  rows: WorktreeStatus[];
  /** the project the shell is scoped to: the rail, ⌘1–9, ⌘K and settings show only its worktrees.
   * The daemon keeps every repo's procs and agents running regardless; this is a view choice. */
  activeRepoId: string | null;
  /** the rows toyon owns in the active repo, minus `removing` (kept in step by the reducer so
   * selectors stay stable). Owned only, and in the daemon's order: ⌘1-9 indexes this positionally,
   * the palette numbers its "switch to" rows from it, and the project pill counts tasks as
   * `length - 1`. A found row entering it would move all three silently. */
  visible: OwnedWorktree[];
  /** removes this tab has sent and the daemon has not yet confirmed. The row leaves the screen
   * on the click rather than when the daemon's next worktrees frame lands, which sits behind
   * killing the procs and the agent. `worktrees` stays the daemon's list: the snapshot that no
   * longer carries an id retires it here, an error frame brings every pending row back, and a
   * hello starts clean because a daemon that restarted mid-remove may still list it. */
  removing: string[];
  /** the landing op (sync, merge, ship, commit) this tab has sent for a worktree and the daemon
   * has not answered. Not optimistic, unlike `removing`: a remove's outcome is known and its
   * failure rare, while these end in ordinary results (a conflict, a hook rejecting the message,
   * nothing to commit) that are not errors to roll back from. So the row shows it working and
   * the shipped frame says what happened. That frame retires the worktree's entry, an error
   * frame (which carries no id) retires all of them, a snapshot without the worktree retires it
   * (a merge can end in a remove), and a hello starts clean. */
  shipping: Record<string, ShipOp>;
  /** the active repo's rows toyon did not create, materialised here for the same reason as
   * `visible` */
  visibleDiscovered: WorktreeStatus[];
  /** per repo: has the discovered section been opened. Collapsed is the default, so the common
   * case (a repo with nothing stray) costs nothing and never surprises anyone. */
  discoveredOpen: Record<string, boolean>;
  /** per repo: the ref palette's last reply, with the query it answered so a stale one is told
   * from the one the person is waiting on. Repo-scoped, since a ref is not a worktree's. */
  refs: Record<string, { query: string; refs: RefHit[] }>;
  /** the worktree last selected in each repo: switching back to a project lands where you left it.
   * Persisted (App.tsx), so it survives a reload the same way the panel layout does. */
  lastActive: Record<string, string>;
  /** an "open project" was sent: the next repo the daemon adds becomes the active one */
  pendingOpen: boolean;
  activeId: string | null;
  /** this tab's id; a worktree created from here steals focus, one created elsewhere does not */
  clientId: string;
  /** worktree selected before the last reload, restored on hello */
  storedActive: string | null;
  storedRepo: string | null;
  /** the daemon has said hello, over the socket or the bootstrap fetch: what the shell shows
   * before that is nothing, not a placeholder for an empty daemon */
  heard: boolean;
  local: Record<string, WorktreeLocal>;
  /** the file the editor pane has open; null when the pane is closed */
  editor: EditorFile | null;
  toast: { ok: boolean; message: string; url?: string; removeIds?: string[] } | null;
  /** bumped to request a preview reload for a worktree (the edit/HMR decision lives in this reducer) */
  reloadReq: { id: string; n: number } | null;
  /** a file is being dragged over the chat panel, which is the one place a drop attaches */
  dragFiles: boolean;
  /** the armed element picker's verb (⌘E's chat, ⌘I's code) + last picked element (pending chat attachment) */
  picking: PickVerb | false;
  pick: (PickedElement & { worktreeId: string }) | null;
  overlay: Overlay | null;
  /** a sub-picker (theme, appearance) was opened from a palette: esc goes back there with the query restored */
  paletteReturn: { mode: "commands" | "quick-open" | "keys"; q: string } | null;
  /** the daemon speaks another protocol version than this build: stop, ask for a reload */
  incompatible: boolean;
  leftOpen: boolean;
  /** bumped to put the keyboard in the changes list; focus is the DOM's, so this only asks */
  focusLeft: number;
  rightOpen: boolean;
  /** bumped to put the keyboard in the composer, the same way */
  focusRight: number;
  /** the worktree panel is kept open, instead of peeking on hover and collapsing to the strip */
  railOpen: boolean;
  /** bumped to put the keyboard on the rail's current row */
  focusRail: number;
  /** the layout each project was last left in; the active one's is what the flags above hold */
  panels: Record<string, Panels>;
  /** one-shot: auto-close the changes panel if the session starts on a clean main, unless the
   * project already has a remembered layout */
  leftAuto: boolean;
  /** full-bleed preview: all chrome hidden */
  zen: boolean;
  /** the terminal pane under the preview (one per worktree; the shells keep running when hidden) */
  termOpen: boolean;
  /** the design pane: the worktree's own design system, beside the preview */
  designOpen: boolean;
  /** themes the daemon knows (built-ins, ~/.toyon/themes, installed editors) + the selection */
  themes: Theme[];
  themePrefs: ThemePrefs;
  /** picker highlight, applied live while browsing */
  previewTheme: Theme | null;
  /** OS appearance (prefers-color-scheme), for themePrefs.mode === "system" */
  systemDark: boolean;
  /** the project picker's path completion: what the daemon found for `query`, and what `query`
   * itself is. `target` is what separates "no such folder" from "nothing matches yet": both arrive
   * as an empty `entries`, and only one of them is somewhere a project can be made. */
  paths: { query: string; entries: PathEntry[]; target: PathTarget | null };
  /** the daemon's home directory, for writing `~` paths the way a person would type them */
  home: string;
  /** clones in flight, held by the daemon so every tab sees them and a reload does not lose them */
  pending: PendingRepo[];
  /** the import being watched in the preview area, if any. Separate from `activeRepoId` because a
   * pending project has no repo record yet, and mixing the two id spaces would be a bug waiting. */
  activeImportId: string | null;
  /** the daemon's agent registry and the default for new worktrees */
  agents: AgentInfo[];
  defaultAgent: string;
  /** what settings asked the daemon about an agent's setup, by agent id */
  agentConfigs: Record<string, AgentConfigInfo>;
  /** the new worktree being drafted, if the draft tab is open */
  draft: Draft | null;
  /** every repo's warm spare, as the daemon last listed them: the preview behind a draft from
   * main, and nothing else. Can shrink between frames (a warm-up rolled back). */
  spares: SpareInfo[];
  /** each repo's most used preview pages, best first, as the daemon ranks them: the route bar's list */
  visits: Record<string, string[]>;
}

export interface InitialOpts {
  /** this tab's id; two tabs must never share one or both would steal focus */
  clientId: string;
  /** the theme painted last time, so there is no flash back to the default before hello */
  cached?: Theme;
  systemDark?: boolean;
  storedActive?: string | null;
  /** project selected before the last reload, restored on hello */
  storedRepo?: string | null;
  /** the worktree panel was left open, so it starts open rather than peeking */
  storedRailOpen?: boolean;
  /** every project's remembered panel layout; the stored project's is painted before hello */
  storedPanels?: Record<string, Panels>;
  /** the worktree each project was left on, so switching projects after a reload lands where you
   * left off rather than on main */
  storedLastActive?: Record<string, string>;
  /** which projects had the discovered section open, so it does not re-collapse on every reload */
  storedDiscoveredOpen?: Record<string, boolean>;
}

export function initialState(opts: InitialOpts): State {
  const cached = opts.cached ?? toyonDark;
  const state: State = {
    connected: false,
    connectFailure: null,
    repos: [],
    rows: [],
    activeRepoId: null,
    visible: [],
    removing: [],
    shipping: {},
    visibleDiscovered: [],
    discoveredOpen: opts.storedDiscoveredOpen ?? {},
    refs: {},
    lastActive: opts.storedLastActive ?? {},
    pendingOpen: false,
    activeId: null,
    clientId: opts.clientId,
    storedActive: opts.storedActive ?? null,
    storedRepo: opts.storedRepo ?? null,
    heard: false,
    local: {},
    editor: null,
    toast: null,
    reloadReq: null,
    dragFiles: false,
    picking: false,
    pick: null,
    overlay: null,
    paletteReturn: null,
    incompatible: false,
    leftOpen: true,
    focusLeft: 0,
    rightOpen: true,
    focusRight: 0,
    railOpen: opts.storedRailOpen ?? false,
    focusRail: 0,
    panels: opts.storedPanels ?? {},
    leftAuto: true,
    zen: false,
    termOpen: false,
    designOpen: false,
    themes: builtinThemes.some((t) => t.id === cached.id) ? builtinThemes : [...builtinThemes, cached],
    themePrefs: { ...defaultThemePrefs, mode: cached.kind, [cached.kind]: cached.id },
    previewTheme: null,
    systemDark: opts.systemDark ?? true,
    paths: { query: "", entries: [], target: null },
    home: "",
    pending: [],
    activeImportId: null,
    agents: [],
    defaultAgent: "claude",
    agentConfigs: {},
    draft: null,
    spares: [],
    visits: {},
  };
  // paint the last project's layout before the daemon's hello names it, so a reload does not
  // flash the docks open and then shut them
  const stored = opts.storedRepo ? state.panels[opts.storedRepo] : undefined;
  return stored ? applyPanels(state, stored) : state;
}

/** the theme to paint right now: picker preview beats prefs */
export function currentTheme(s: State): Theme {
  return s.previewTheme ?? resolveTheme(s.themePrefs, s.themes, s.systemDark);
}

export function localOf(s: State, id: string | null | undefined): WorktreeLocal {
  return (id && s.local[id]) || EMPTY_LOCAL;
}

/** any row by id, owned or not */
export function rowById(s: State, id: string | null | undefined): WorktreeStatus | null {
  return (id && s.rows.find((w) => w.id === id)) || null;
}

/** a row toyon owns, by id: what the chat, the composer and landing read */
export function worktreeById(s: State, id: string | null | undefined): OwnedWorktree | null {
  const row = rowById(s, id);
  return row && isOwned(row) ? row : null;
}

/** A project with nothing in it and nothing said yet: main's tree is empty, the repo has no
 * confirmed config, and the transcript is blank. The composer moves to the centre for exactly as
 * long as this holds; the first message ends it on its own, since the daemon echoes it back. */
export function isGreenfield(s: State): boolean {
  const wt = worktreeById(s, s.activeId);
  // the empty-tree fact rides on main's record, so the first frame already answers this
  if (!wt || !isMain(wt.worktree) || wt.agent !== "idle" || wt.worktree.empty !== true) return false;
  const repo = repoById(s, wt.repoId);
  return !!repo?.needsSetup && localOf(s, wt.id).chat.length === 0;
}

export function repoById(s: State, id: string | null | undefined): RepoInfo | null {
  return (id && s.repos.find((r) => r.id === id)) || null;
}

/** a repo's main row, which is what a draft branches from when nothing else is named */
export function mainOf(s: State, repoId: string | null): OwnedWorktree | null {
  return (repoId && s.rows.filter(isOwned).find((w) => w.repoId === repoId && isMain(w.worktree))) || null;
}

/** the spare behind the draft: the base repo's, when the draft is from main and one is ready.
 * Its preview is the code the worktree will start from. An element of `spares`, so stable across
 * renders that carry the same frame. */
export function draftSpareOf(s: State): SpareInfo | null {
  const base = s.draft ? worktreeById(s, s.draft.base) : null;
  if (!base || !isMain(base.worktree)) return null;
  return s.spares.find((sp) => sp.repoId === base.repoId && sp.ready) ?? null;
}

/** the preview on screen: the draft's (its spare, else its base's own), or the active worktree's.
 * The element picker and the bridge's page context follow this one, not `activeId`. */
export function previewIdOf(s: State): string | null {
  if (!s.draft) return s.activeId;
  return draftSpareOf(s)?.id ?? s.draft.base;
}

/** the active repo's owned rows; every repo's when nothing is selected (a daemon with no repos).
 * A row whose remove is in flight is already gone from the person's point of view. */
function visibleOf(rows: WorktreeStatus[], repoId: string | null, removing: string[]): OwnedWorktree[] {
  const owned = rows.filter(isOwned);
  const shown = removing.length ? owned.filter((w) => !removing.includes(w.id)) : owned;
  return repoId ? shown.filter((w) => w.repoId === repoId) : shown;
}

/** the same narrowing for the rows toyon did not create */
function visibleDiscoveredOf(rows: WorktreeStatus[], repoId: string | null): WorktreeStatus[] {
  const found = rows.filter((r) => !isOwned(r));
  return repoId ? found.filter((d) => d.repoId === repoId) : found;
}

/** the worktree to land on in a repo: the one last selected there, else its first owned row
 * (main). Never a found row, which may be gone next push, and never a row whose remove is
 * pending: it is off screen, and landing on it would select nothing. */
function landingIn(s: State, repoId: string | null, rows = s.rows): string | null {
  const owned = rows.filter(isOwned);
  const live = s.removing.length ? owned.filter((w) => !s.removing.includes(w.id)) : owned;
  if (!repoId) return live[0]?.id ?? null;
  const last = s.lastActive[repoId];
  if (last && live.some((w) => w.id === last)) return last;
  return live.find((w) => w.repoId === repoId)?.id ?? null;
}

/** the four client messages that end in a `shipped` frame: the daemon's word for them */
export type ShipOp = "sync-main" | "merge-main" | "ship" | "commit" | "pull-main";

/** `shipping` minus the entries `done` says are over, the same object when none are, so a
 * selector on it stays stable across the proc events that push most snapshots */
function retireShipping(shipping: Record<string, ShipOp>, done: (id: string) => boolean): Record<string, ShipOp> {
  const entries = Object.entries(shipping);
  const keep = entries.filter(([id]) => !done(id));
  if (keep.length === entries.length) return shipping;
  return Object.fromEntries(keep);
}

/** select a worktree, and with it its repo (a chord or a rail click never leaves you scoped to
 * a project that is not the one on screen) */
function activate(s: State, id: string | null): State {
  const row = rowById(s, id);
  // a found worktree can be selected too: it has a shell and a pane of its own, just nothing
  // toyon runs. It is deliberately not written to lastActive, which is the landing spot for a
  // project and should be somewhere that still exists next time.
  const activeRepoId = row?.repoId ?? s.activeRepoId;
  const lastActive = row && isOwned(row) ? { ...s.lastActive, [row.repoId]: row.id } : s.lastActive;
  // choosing a row is leaving the draft, the base's own row included: a snapshot that only
  // re-asserts the selection puts the draft back itself (see the worktrees frame)
  return { ...s, activeId: id, activeRepoId, lastActive, editor: null, draft: null };
}

/** the draft after a frame: kept while its base is still listed, dropped once the worktree it was
 * for exists (the row this tab created lands, and the draft's text went with it) */
function draftAfter(s: State, rows: WorktreeStatus[], created: boolean): Draft | null {
  if (!s.draft || created) return null;
  return rows.some((w) => w.id === s.draft?.base) ? s.draft : null;
}

export const isSubPicker = (o: Overlay) =>
  o.kind === "theme" || o.kind === "appearance" || o.kind === "agent" || o.kind === "agent-page";

/** what reaches the reducer: terminal frames are routed to the pane, and file answers to fileSync,
 * before dispatch (main.tsx) */
export type StoreServerMsg = Exclude<ServerMsg, TermServerMsg | FileServerMsg>;

export type Action =
  | { a: "server"; msg: StoreServerMsg }
  | { a: "connected"; v: boolean; failure?: ConnectFailure | null }
  | { a: "activate"; id: string }
  /** open the draft tab: a new worktree from `base`, the active project's main when absent. The
   * same base again closes it, so the chord toggles; another base moves it. */
  | { a: "open-draft"; base?: string }
  | { a: "close-draft" }
  | { a: "draft-variants"; n: Draft["variants"] }
  | { a: "draft-batch"; v: boolean }
  | { a: "draft-agent"; id: string }
  | { a: "draft-profile"; profile: string }
  /** switch the shell to another registered repo */
  | { a: "activate-repo"; id: string }
  /** remove-worktree frames went out for these: hide the rows now, move the selection off them */
  | { a: "remove-worktrees"; ids: string[] }
  /** a landing op went out for this worktree: show it working until the shipped frame */
  | { a: "shipping"; id: string; op: ShipOp }
  /** an "open project" request went to the daemon: adopt the repo it adds */
  | { a: "open-repo" }
  /** show a clone's progress in the preview area (null stops watching) */
  | { a: "watch-import"; id: string | null }
  | { a: "close-editor" }
  /** the editor pane opens this file now; fileSync reads it */
  | { a: "open-file"; v: OpenFile }
  /** fileSync: what a read of the open file found, or why it could not read it */
  | { a: "editor-read"; file: FileRef; disk: EditorDisk | null; error?: string }
  /** fileSync: the file changed on disk under unsaved edits (what is there now), or that was settled */
  | { a: "editor-conflict"; file: FileRef; theirs: EditorFile["conflict"] }
  /** switch the open file between its diff and the file */
  | { a: "editor-view"; v: EditorView }
  | { a: "dismiss-toast" }
  | { a: "set-draft"; id: string; text: string }
  /** the composer's up and down: the draft and where the walk is, in one write */
  | { a: "walk"; id: string; walk: ComposerWalk | null; text: string }
  | { a: "add-images"; id: string; images: PendingImage[] }
  | { a: "remove-image"; id: string; key: string }
  | { a: "clear-images"; id: string }
  | { a: "add-paste"; id: string; paste: PendingPaste }
  | { a: "remove-paste"; id: string; key: string }
  | { a: "clear-pastes"; id: string }
  | { a: "hmr"; id: string }
  | { a: "page"; id: string; url?: string; title?: string; error?: string; fresh?: boolean }
  | { a: "drag-files"; v: boolean }
  | { a: "set-picking"; v: PickVerb | false }
  | { a: "picked"; pick: NonNullable<State["pick"]> }
  | { a: "clear-pick" }
  /** open an overlay (closes any other); palettes forget a pending return, sub-pickers keep it */
  | { a: "open"; overlay: Overlay }
  /** close the open overlay; with `back`, reopen the palette a sub-picker came from */
  | { a: "close"; back?: boolean }
  | { a: "toggle"; overlay: Overlay }
  | { a: "palette-return"; v: State["paletteReturn"] }
  | { a: "toggle-left" }
  /** open the changes panel if it is shut, and ask it for the keyboard either way */
  | { a: "focus-left" }
  | { a: "toggle-right" }
  /** open the chat panel if it is shut, and ask the composer for the keyboard either way */
  | { a: "focus-right" }
  /** the first greenfield message was sent: the chat goes back to its dock */
  | { a: "show-right" }
  | { a: "toggle-rail" }
  /** pin the worktree panel if it is not, and ask its current row for the keyboard either way */
  | { a: "focus-rail" }
  /** open or close the active project's discovered section */
  | { a: "toggle-discovered" }
  | { a: "toggle-zen" }
  | { a: "toggle-terminal" }
  | { a: "toggle-design" }
  /** show this worktree's stream in the terminal pane, opening the pane if it was hidden */
  | { a: "term-stream"; id: string; stream: string }
  | { a: "preview-theme"; theme: Theme | null }
  | { a: "system-dark"; v: boolean }
  | { a: "toast"; toast: NonNullable<State["toast"]> }
  | { a: "incompatible" };

function withLocal(s: State, id: string, fn: (l: WorktreeLocal) => WorktreeLocal): State {
  return { ...s, local: { ...s.local, [id]: fn(s.local[id] ?? EMPTY_LOCAL) } };
}

/** a sub-picker closed with `back`: reopen the palette it came from (its query rides along in paletteReturn) */
function paletteBack(s: State, back: boolean | undefined): Pick<State, "overlay" | "paletteReturn"> {
  const r = s.paletteReturn;
  if (!back || !r) return { overlay: null, paletteReturn: null };
  return { overlay: { kind: r.mode }, paletteReturn: r };
}

/** landing on a project paints the layout it was left in; one that has never been laid out adopts
 * whatever is on screen, so the switch itself moves nothing */
function enterRepo(s: State): State {
  const id = s.activeRepoId;
  if (!id) return s;
  const p = s.panels[id];
  return p ? applyPanels(s, p) : { ...s, panels: { ...s.panels, [id]: panelsOf(s) } };
}

/** the clean-main auto-close is the one thing that shuts a panel without anyone asking, so it is
 * the one thing the layout must not learn from: it would outlive the clean main that prompted it */
function guessed(action: Action): boolean {
  return action.a === "server" && action.msg.t === "git-status";
}

export function reducer(s: State, action: Action): State {
  let next = reduce(s, action);
  // every open/close routes through here, so the layout is remembered in one place rather than in
  // the dozen actions (a chord, a rail click, a dropped file) that move it
  if (next.activeRepoId !== s.activeRepoId) next = enterRepo(next);
  else if (next.activeRepoId && !guessed(action) && !samePanels(panelsOf(s), panelsOf(next))) {
    next = { ...next, panels: { ...next.panels, [next.activeRepoId]: panelsOf(next) } };
  }
  if (next.rows === s.rows && next.activeRepoId === s.activeRepoId && next.removing === s.removing) {
    return next;
  }
  return {
    ...next,
    visible: visibleOf(next.rows, next.activeRepoId, next.removing),
    visibleDiscovered: visibleDiscoveredOf(next.rows, next.activeRepoId),
  };
}

function reduce(s: State, action: Action): State {
  switch (action.a) {
    case "connected":
      // a retry's bare close keeps the last diagnosis: the probe that follows replaces it, and
      // showing "connecting" in between would flicker the pane on every backoff
      return { ...s, connected: action.v, connectFailure: action.v ? null : (action.failure ?? s.connectFailure) };
    case "activate":
      return activate(s, action.id);
    case "open-draft": {
      // not on an empty project: a worktree off the root commit would take the scaffold to a
      // branch while main stayed blank
      if (isGreenfield(s)) return s;
      const base = action.base ?? mainOf(s, s.activeRepoId)?.id ?? null;
      if (!base || !worktreeById(s, base)) return s;
      if (s.draft?.base === base) return { ...s, draft: null };
      // the chat dock is where the draft is written, so it has to be on screen; a palette the
      // chord was pressed over would sit in front of it
      return {
        ...activate(s, base),
        draft: { base, variants: 1, batch: false, agent: s.defaultAgent },
        rightOpen: true,
        overlay: null,
        paletteReturn: null,
      };
    }
    case "close-draft":
      return s.draft ? { ...s, draft: null } : s;
    case "draft-variants":
      return s.draft ? { ...s, draft: { ...s.draft, variants: action.n } } : s;
    case "draft-batch":
      return s.draft ? { ...s, draft: { ...s.draft, batch: action.v } } : s;
    case "draft-agent":
      return s.draft ? { ...s, draft: { ...s.draft, agent: action.id } } : s;
    case "draft-profile":
      return s.draft ? { ...s, draft: { ...s.draft, profile: action.profile } } : s;
    case "remove-worktrees": {
      const ids = action.ids.filter((id) => !s.removing.includes(id) && worktreeById(s, id));
      if (ids.length === 0) return s;
      const hidden = { ...s, removing: [...s.removing, ...ids] };
      // the selection leaves with the row, the way the daemon's own snapshot would move it
      return s.activeId && ids.includes(s.activeId) ? activate(hidden, landingIn(hidden, s.activeRepoId)) : hidden;
    }
    case "shipping": {
      // one op per worktree at a time: the daemon serializes them under the repo lock anyway,
      // and a second press before the answer is the double-click this state exists to absorb
      // any row: a found worktree can be synced, and its dot shows the op the same way
      if (s.shipping[action.id] || !rowById(s, action.id)) return s;
      return { ...s, shipping: { ...s.shipping, [action.id]: action.op } };
    }
    case "activate-repo": {
      if (action.id === s.activeRepoId || !repoById(s, action.id)) return s;
      const id = landingIn(s, action.id);
      // an explicit switch beats a pending one: a clone can take minutes, and its repo arriving
      // afterwards must not yank the person out of whatever they moved to in the meantime
      return { ...activate(s, id), activeRepoId: action.id, pendingOpen: false };
    }
    case "open-repo":
      return { ...s, pendingOpen: true };
    case "watch-import":
      return { ...s, activeImportId: action.id };
    case "close-editor":
      return { ...s, editor: null };
    case "open-file": {
      const v = action.v;
      const e = s.editor;
      // the file already open keeps its text and view on screen while its fresh read is out
      const same = e && e.worktreeId === v.worktreeId && e.path === v.path && e.ref === v.ref ? e : null;
      const line = v.line && placeLine(s, v.worktreeId, v.path, v.line);
      return {
        ...s,
        editor: {
          worktreeId: v.worktreeId,
          path: v.path,
          ...(v.ref ? { ref: v.ref } : {}),
          view: v.view ?? same?.view ?? null,
          seq: v.seq,
          disk: same?.disk ?? null,
          ...(line ? { line } : {}),
          focus: v.focus,
          conflict: same?.conflict ?? null,
        },
      };
    }
    case "editor-read": {
      const e = s.editor;
      if (!e || !sameFile(e, action.file)) return s;
      const disk = action.disk;
      if (!disk) {
        const toast = { ok: false, message: action.error ?? `could not read ${e.path}` };
        // a pane with nothing in it yet has nothing to show; one with text keeps it and says why
        return e.disk ? { ...s, toast } : { ...s, editor: null, toast };
      }
      // with no view asked for, a changed file opens on its diff and an unchanged one has none to show
      return { ...s, editor: { ...e, view: e.view ?? (disk.before === disk.after ? "file" : "diff"), disk } };
    }
    case "editor-conflict": {
      const e = s.editor;
      return e && sameFile(e, action.file) ? { ...s, editor: { ...e, conflict: action.theirs } } : s;
    }
    case "editor-view":
      // the line was a one-time jump; past a switch the editor carries its own place, and a line
      // kept for the diff view would land inside a collapsed region the next time the file is read
      return s.editor ? { ...s, editor: { ...s.editor, view: action.v, line: undefined } } : s;
    case "dismiss-toast":
      return { ...s, toast: null };
    case "set-draft":
      return withLocal(s, action.id, ({ walk: _walk, ...l }) => ({ ...l, draft: action.text }));
    case "walk":
      return withLocal(s, action.id, ({ walk: _walk, ...l }) => ({
        ...l,
        draft: action.text,
        ...(action.walk ? { walk: action.walk } : {}),
      }));
    case "add-images":
      // the chips are the only sign an attachment landed, so a drop on a collapsed chat opens it
      return withLocal({ ...s, rightOpen: true }, action.id, (l) => ({
        ...l,
        images: [...l.images, ...action.images],
      }));
    case "remove-image":
      return withLocal(s, action.id, (l) => ({ ...l, images: l.images.filter((i) => i.key !== action.key) }));
    case "clear-images":
      return withLocal(s, action.id, (l) => (l.images.length ? { ...l, images: [] } : l));
    case "add-paste":
      return withLocal(s, action.id, (l) => ({ ...l, pastes: [...l.pastes, action.paste] }));
    case "remove-paste":
      return withLocal(s, action.id, (l) => ({ ...l, pastes: l.pastes.filter((p) => p.key !== action.key) }));
    case "clear-pastes":
      return withLocal(s, action.id, (l) => (l.pastes.length ? { ...l, pastes: [] } : l));
    case "hmr":
      return withLocal(s, action.id, (l) => ({ ...l, turn: { ...l.turn, hmr: true } }));
    case "page":
      return withLocal(s, action.id, (l) => ({
        ...l,
        page: {
          url: action.url ?? l.page.url,
          title: action.title ?? l.page.title,
          errors: action.fresh ? [] : action.error ? [...l.page.errors.slice(-2), action.error] : l.page.errors,
        },
      }));
    case "drag-files":
      return s.dragFiles === action.v ? s : { ...s, dragFiles: action.v };
    case "set-picking":
      return { ...s, picking: action.v };
    case "picked":
      // the pick is a chat attachment, so make sure the chat is visible to receive it
      return { ...s, picking: false, pick: action.pick, rightOpen: true };
    case "clear-pick":
      return { ...s, pick: null };
    case "open":
      // any overlay change drops the theme picker's live preview so the kept theme paints again
      return {
        ...s,
        overlay: action.overlay,
        previewTheme: null,
        paletteReturn: isSubPicker(action.overlay) ? s.paletteReturn : null,
      };
    case "close":
      return { ...s, previewTheme: null, ...paletteBack(s, action.back) };
    case "toggle":
      return s.overlay?.kind === action.overlay.kind
        ? reducer(s, { a: "close" })
        : reducer(s, { a: "open", overlay: action.overlay });
    case "palette-return":
      return { ...s, paletteReturn: action.v };
    case "toggle-left":
      return { ...s, leftOpen: !s.leftOpen, leftAuto: false };
    case "focus-left":
      return { ...s, leftOpen: true, leftAuto: false, focusLeft: s.focusLeft + 1 };
    case "toggle-right":
      return { ...s, rightOpen: !s.rightOpen };
    case "focus-right":
      return { ...s, rightOpen: true, focusRight: s.focusRight + 1 };
    case "show-right":
      return s.rightOpen ? s : { ...s, rightOpen: true };
    case "toggle-rail":
      return { ...s, railOpen: !s.railOpen };
    case "focus-rail":
      return { ...s, railOpen: true, focusRail: s.focusRail + 1 };
    case "toggle-discovered": {
      const repoId = s.activeRepoId;
      if (!repoId) return s;
      return { ...s, discoveredOpen: { ...s.discoveredOpen, [repoId]: !s.discoveredOpen[repoId] } };
    }
    case "toggle-zen":
      return { ...s, zen: !s.zen, toast: !s.zen ? { ok: true, message: "⌘. to exit" } : s.toast };
    case "toggle-terminal":
      return { ...s, termOpen: !s.termOpen };
    case "toggle-design":
      return { ...s, designOpen: !s.designOpen };
    case "term-stream":
      return withLocal({ ...s, termOpen: true }, action.id, (l) => ({ ...l, termStream: action.stream }));
    case "preview-theme":
      return { ...s, previewTheme: action.theme };
    case "system-dark":
      return { ...s, systemDark: action.v };
    case "toast":
      return { ...s, toast: action.toast };
    case "incompatible":
      return { ...s, incompatible: true, connected: false };
    case "server":
      return onServer(s, action.msg);
  }
}

/** drop per-worktree records for rows the daemon no longer lists, found rows included: theirs
 * hold git status and history too, and a push arrives on every proc event. A spare's record (the
 * page state its preview reports) lives as long as it is listed; a draft's is never a row's and
 * stays until the draft is sent. */
function pruneLocal(local: State["local"], rows: WorktreeStatus[], spares: SpareInfo[]): State["local"] {
  const keep = new Set([...rows.map((w) => w.id), ...spares.map((sp) => sp.id)]);
  const kept = (id: string) => keep.has(id) || id.startsWith(DRAFT_PREFIX);
  if (Object.keys(local).every(kept)) return local;
  return Object.fromEntries(Object.entries(local).filter(([id]) => kept(id)));
}

/** drop the per-project landing spots whose worktree is gone; the fallback is that project's main
 * either way, this just keeps dead ids out of storage */
function pruneLastActive(lastActive: Record<string, string>, rows: WorktreeStatus[]): Record<string, string> {
  const keep = new Set(rows.map((w) => w.id));
  if (Object.values(lastActive).every((id) => keep.has(id))) return lastActive;
  return Object.fromEntries(Object.entries(lastActive).filter(([, id]) => keep.has(id)));
}

/** drop remembered flags for projects the daemon no longer has, so forgetting a project does not
 * leave its key in storage forever */
function pruneByRepo<T>(flags: Record<string, T>, repos: RepoInfo[]): Record<string, T> {
  const keep = new Set(repos.map((r) => r.id));
  if (Object.keys(flags).every((id) => keep.has(id))) return flags;
  return Object.fromEntries(Object.entries(flags).filter(([id]) => keep.has(id)));
}

function onServer(s: State, msg: StoreServerMsg): State {
  switch (msg.t) {
    case "hello": {
      // restore the previously selected worktree across reloads, a found one included: it is
      // still listed, and its shell and dock are what the person was looking at
      const has = (id: string | null) => !!id && msg.rows.some((w) => w.id === id);
      const hasRepo = (id: string | null) => !!id && msg.repos.some((r) => r.id === id);
      // the project narrows the fallback: a stored repo whose stored worktree is gone still opens
      // on that repo, not on whichever worktree the daemon lists first
      const repoId = hasRepo(s.activeRepoId) ? s.activeRepoId : hasRepo(s.storedRepo) ? s.storedRepo : null;
      const activeId = has(s.activeId)
        ? s.activeId
        : has(s.storedActive)
          ? s.storedActive
          : landingIn(s, repoId, msg.rows);
      const wt = msg.rows.find((w) => w.id === activeId);
      return {
        ...s,
        heard: true,
        repos: msg.repos,
        rows: msg.rows,
        activeId,
        activeRepoId: wt?.repoId ?? repoId ?? msg.repos[0]?.id ?? null,
        spares: msg.spares,
        draft: draftAfter(s, msg.rows, false),
        removing: s.removing.length ? [] : s.removing,
        shipping: retireShipping(s.shipping, () => true),
        local: pruneLocal(s.local, msg.rows, msg.spares),
        lastActive: pruneLastActive(s.lastActive, msg.rows),
        discoveredOpen: pruneByRepo(s.discoveredOpen, msg.repos),
        refs: pruneByRepo(s.refs, msg.repos),
        themes: msg.themes ?? s.themes,
        themePrefs: msg.themePrefs ?? s.themePrefs,
        agents: msg.agents,
        defaultAgent: msg.defaultAgent,
        home: msg.home,
        pending: msg.pending,
        visits: msg.visits,
        // an import this tab was watching may have finished while it was away
        activeImportId: msg.pending.some((x) => x.id === s.activeImportId) ? s.activeImportId : null,
      };
    }
    case "visits":
      return { ...s, visits: { ...s.visits, [msg.repoId]: msg.paths } };
    case "themes":
      return { ...s, themes: msg.themes, themePrefs: msg.prefs };
    case "agents":
      return { ...s, agents: msg.agents, defaultAgent: msg.defaultAgent };
    case "agent-config": {
      const { t: _t, ...info } = msg;
      return { ...s, agentConfigs: { ...s.agentConfigs, [info.agent]: info } };
    }
    case "pending-repos": {
      const known = new Set(s.pending.map((x) => x.id));
      const started = msg.pending.find((x) => !known.has(x.id));
      // pendingOpen already means "this tab asked for a project to arrive", which is exactly who
      // should be shown the clone: the tabs that did not ask carry on with what they were doing
      const watch = started && s.pendingOpen ? started.id : s.activeImportId;
      // when the watched one finishes, stop watching: the repo it became arrives in the same
      // breath and pendingOpen is what lands on it
      const stillThere = msg.pending.some((x) => x.id === watch);
      // a failed import never becomes a repo, so the flag would otherwise sit armed and make some
      // unrelated project that arrives later steal this tab
      const failed = msg.pending.some((x) => x.id === watch && x.error);
      return {
        ...s,
        pending: msg.pending,
        activeImportId: stillThere ? watch : null,
        pendingOpen: failed ? false : s.pendingOpen,
      };
    }
    case "path-entries":
      return { ...s, paths: { query: msg.query, entries: msg.entries, target: msg.target } };
    case "refs":
      return { ...s, refs: { ...s.refs, [msg.repoId]: { query: msg.query, refs: msg.refs } } };
    case "repos": {
      const known = new Set(s.repos.map((r) => r.id));
      const added = msg.repos.find((r) => !known.has(r.id));
      let activeRepoId = s.activeRepoId;
      let pendingOpen = s.pendingOpen;
      if (added && (pendingOpen || !activeRepoId)) {
        // the project this tab asked to open (or the daemon's first repo ever): switch to it; its
        // worktrees frame follows and the landing rule below picks its main row
        activeRepoId = added.id;
        pendingOpen = false;
      } else if (!msg.repos.some((r) => r.id === activeRepoId)) {
        activeRepoId = msg.repos[0]?.id ?? null;
      }
      if (activeRepoId === s.activeRepoId) return { ...s, repos: msg.repos, pendingOpen };
      return { ...s, repos: msg.repos, pendingOpen, activeRepoId, activeId: landingIn(s, activeRepoId), editor: null };
    }
    case "worktrees": {
      let activeId = s.activeId;
      // the selection holds as long as its row is still listed, found rows included: a push
      // arrives on every proc event and must not bounce the selection back to an owned row
      if (!activeId || !msg.rows.some((w) => w.id === activeId)) {
        activeId = landingIn(s, s.activeRepoId, msg.rows);
      }
      // auto-focus a worktree THIS tab just created (the "prompt spawns a tab" moment); one made
      // from another tab or the CLI stays where it is
      const known = new Set(s.rows.map((w) => w.id));
      const fresh = msg.rows.find(
        (w) => !known.has(w.id) && w.worktree?.kind === "worktree" && w.worktree.createdBy === s.clientId,
      );
      if (fresh && s.rows.length > 0) activeId = fresh.id;
      // a pending remove is done once the daemon stops listing the row; one it still lists is
      // still in flight (this frame is as likely another worktree's proc event as the reply)
      const removing = s.removing.filter((id) => msg.rows.some((w) => w.id === id));
      return {
        ...activate(
          {
            ...s,
            rows: msg.rows,
            spares: msg.spares,
            removing: removing.length === s.removing.length ? s.removing : removing,
            shipping: retireShipping(s.shipping, (id) => !msg.rows.some((w) => w.id === id)),
            local: pruneLocal(s.local, msg.rows, msg.spares),
          },
          activeId,
        ),
        draft: draftAfter(s, msg.rows, !!fresh),
      };
    }
    case "proc": {
      const rows = s.rows.map((w) => (w.id === msg.worktreeId ? { ...w, procs: upsertProc(w.procs, msg.proc) } : w));
      return { ...s, rows };
    }
    case "log":
      return withLocal(s, msg.worktreeId, (l) => ({
        ...l,
        log: [...l.log.slice(-400), { proc: msg.proc, line: msg.line }],
      }));
    case "agent": {
      const ev = msg.event;
      const id = msg.worktreeId;
      let next = withLocal(s, id, (l) => {
        const chat = applyEvent(l.chat, ev);
        let turn = l.turn;
        if (ev.type === "turn-start") turn = { edits: false, hmr: false };
        else if (ev.type === "tool-start" && isEditTool(ev)) turn = { ...turn, edits: true };
        // what actually ran, for the model and effort chips: the agent's word, not the record's
        const model = ev.type === "session-info" && ev.model ? ev.model : l.model;
        const effort = ev.type === "session-info" && ev.effort ? ev.effort : l.effort;
        const usage = ev.type === "usage" ? figuresOf(ev) : l.usage;
        return {
          ...l,
          chat,
          turn,
          ...(model !== l.model ? { model } : {}),
          ...(effort !== l.effort ? { effort } : {}),
          ...(usage !== l.usage ? { usage } : {}),
        };
      });
      if (ev.type === "turn-end") {
        // edits happened but nothing hot-updated: the change is outside HMR's reach
        // (backend/data) — ask the preview to reload itself
        const turn = next.local[id]!.turn;
        if (turn.edits && !turn.hmr) next = { ...next, reloadReq: { id, n: (next.reloadReq?.n ?? 0) + 1 } };
      }
      return next;
    }
    case "backfill": {
      let chat: ChatItem[] = [];
      let usage: UsageFigures | undefined;
      for (const { event } of msg.events) {
        chat = applyEvent(chat, event);
        if (event.type === "usage") usage = figuresOf(event);
      }
      return withLocal(s, msg.worktreeId, (l) => ({ ...l, chat, log: msg.log ?? l.log, ...(usage ? { usage } : {}) }));
    }
    case "git-status": {
      // session opened on a clean main: nothing to show — close the changes panel once
      let leftOpen = s.leftOpen;
      let leftAuto = s.leftAuto;
      if (s.leftAuto && msg.worktreeId === s.activeId) {
        const wt = worktreeById(s, msg.worktreeId);
        if (wt && isMain(wt.worktree) && msg.files.length === 0 && (msg.committed?.length ?? 0) === 0) {
          leftOpen = false;
        }
        leftAuto = false;
      }
      // ranges go stale whenever the worktree's git state moves
      const next = withLocal(s, msg.worktreeId, (l) => ({
        ...l,
        git: { files: msg.files, committed: msg.committed, ahead: msg.ahead, behind: msg.behind, head: msg.head },
        changedRanges: {},
      }));
      return { ...next, leftOpen, leftAuto };
    }
    case "changed-ranges": {
      const next = withLocal(s, msg.worktreeId, (l) => ({
        ...l,
        changedRanges: { ...l.changedRanges, [msg.path]: { ranges: msg.ranges, offset: msg.lineOffset } },
      }));
      // the offset this reply carries is what a jump to a line the page reported was waiting for
      const e = next.editor;
      if (!e?.line?.fiber || e.worktreeId !== msg.worktreeId || e.path !== msg.path) return next;
      return { ...next, editor: { ...e, line: placeLine(next, e.worktreeId, e.path, e.line) } };
    }
    case "shipped": {
      // a suggestion lands in that worktree's composer and focuses it
      const next = msg.suggestion
        ? withLocal(activate(s, msg.worktreeId), msg.worktreeId, (l) => ({ ...l, draft: msg.suggestion! }))
        : s;
      return {
        ...next,
        shipping: retireShipping(next.shipping, (id) => id === msg.worktreeId),
        toast: {
          ok: msg.ok,
          message: msg.message,
          url: msg.url,
          removeIds: msg.merged && msg.ok ? (msg.removeIds ?? [msg.worktreeId]) : undefined,
        },
      };
    }
    case "files":
      return withLocal(s, msg.worktreeId, (l) => ({ ...l, files: msg.paths }));
    case "search-results":
      return withLocal(s, msg.worktreeId, (l) => ({
        ...l,
        search: { query: msg.query, hits: msg.hits, truncated: msg.truncated },
      }));
    case "design-index":
      return withLocal(s, msg.worktreeId, (l) => ({ ...l, design: msg.index }));
    case "queue":
      return withLocal(s, msg.worktreeId, (l) => ({ ...l, queue: msg.items }));
    case "agent-commands":
      return withLocal(s, msg.worktreeId, (l) => ({ ...l, commands: msg.commands }));
    case "git-log":
      // the expanded commit's files outlive the list they came with: the same shas are usually
      // still there after a refresh, and re-fetching them would collapse the row under the cursor
      return withLocal(s, msg.worktreeId, (l) => ({ ...l, commits: msg.commits }));
    case "git-commit":
      return withLocal(s, msg.worktreeId, (l) => ({
        ...l,
        commitFiles: { ...l.commitFiles, [msg.sha]: msg.files },
      }));
    case "error":
      // the frame carries no worktree id, so every pending remove comes back (the daemon's next
      // snapshot re-hides any that did in fact go through) and every landing op comes to rest
      return {
        ...s,
        toast: { ok: false, message: msg.message },
        removing: s.removing.length ? [] : s.removing,
        shipping: retireShipping(s.shipping, () => true),
      };
    default: {
      // exhaustive at compile time, but a daemon one version ahead can still send a `t` this
      // build has never heard of, and returning undefined here blanks the tab on the next read
      const unknown: never = msg;
      void unknown;
      return s;
    }
  }
}

function upsertProc(procs: WorktreeStatus["procs"], p: WorktreeStatus["procs"][number]) {
  const idx = procs.findIndex((x) => x.name === p.name);
  if (idx === -1) return [...procs, p];
  const next = procs.slice();
  next[idx] = p;
  return next;
}

export /** the agent's figures as the store keeps them: cost only when it reported one */
function figuresOf(ev: Extract<AgentEvent, { type: "usage" }>): UsageFigures {
  return { used: ev.used, size: ev.size, ...(ev.cost !== undefined ? { cost: ev.cost } : {}) };
}

function applyEvent(items: ChatItem[], event: AgentEvent): ChatItem[] {
  const last = items[items.length - 1];
  switch (event.type) {
    case "user-message":
      return [
        ...items,
        {
          kind: "user",
          text: event.text,
          pick: event.pick,
          ...(event.images?.length ? { images: event.images } : {}),
          ...(event.pastes?.length ? { pastes: event.pastes } : {}),
        },
      ];
    case "text-delta":
      if (last?.kind === "assistant") return [...items.slice(0, -1), { ...last, text: last.text + event.text }];
      return [...items, { kind: "assistant", text: event.text }];
    case "thinking-delta":
      if (last?.kind === "thinking") return [...items.slice(0, -1), { ...last, text: last.text + event.text }];
      return [...items, { kind: "thinking", text: event.text }];
    case "tool-start":
      return [
        ...items,
        {
          kind: "tool",
          id: event.toolId,
          name: event.name,
          input: event.input,
          done: false,
          ...(event.kind ? { toolKind: event.kind } : {}),
          ...(event.title ? { title: event.title } : {}),
          ...(event.parentToolId ? { parentToolId: event.parentToolId } : {}),
          ...(event.subagent ? { subagent: true } : {}),
        },
      ];
    case "tool-update": {
      const idx = items.findLastIndex((i) => i.kind === "tool" && i.id === event.toolId);
      if (idx === -1) return items;
      const next = items.slice();
      const tool = next[idx] as Extract<ChatItem, { kind: "tool" }>;
      next[idx] = {
        ...tool,
        ...(event.name ? { name: event.name } : {}),
        ...(event.title ? { title: event.title } : {}),
        ...(event.input !== undefined ? { input: event.input } : {}),
        ...(event.kind ? { toolKind: event.kind } : {}),
      };
      return next;
    }
    case "tool-delta": {
      const idx = items.findLastIndex((i) => i.kind === "tool" && i.id === event.toolId);
      // the spawning row is the only place this text belongs, so a chunk that arrives before it (or
      // after a replay dropped it) is let go rather than opening a row of its own
      if (idx === -1) return items;
      const next = items.slice();
      const tool = next[idx] as Extract<ChatItem, { kind: "tool" }>;
      next[idx] = { ...tool, output: (tool.output ?? "") + event.text };
      return next;
    }
    case "tool-end": {
      const idx = items.findLastIndex((i) => i.kind === "tool" && i.id === event.toolId);
      if (idx === -1) return items;
      const next = items.slice();
      const tool = next[idx] as Extract<ChatItem, { kind: "tool" }>;
      next[idx] = { ...tool, output: event.output, isError: event.isError, done: true };
      return next;
    }
    case "agent-error":
      return [...items, { kind: "error", text: event.message }];
    case "agent-blocked":
      return [...items, { kind: "blocked", tool: event.tool, path: event.path, reason: event.reason }];
    case "grafted":
      return [...items, { kind: "grafted", title: event.title, branch: event.branch }];
    case "agent-auth-required":
      return [
        ...items,
        {
          kind: "auth",
          agent: event.agent,
          agentName: event.agentName,
          methods: event.methods,
          ...(event.rejected ? { rejected: true } : {}),
          done: false,
        },
      ];
    case "agent-auth-ok": {
      const idx = items.findLastIndex((i) => i.kind === "auth" && !i.done);
      if (idx === -1) return items;
      const next = items.slice();
      next[idx] = { ...(next[idx] as Extract<ChatItem, { kind: "auth" }>), done: true };
      return next;
    }
    case "agent-question":
      return addAsk(items, event.toolId, {
        kind: "ask",
        id: event.id,
        ask: { kind: "question", message: event.message, questions: event.questions },
      });
    case "agent-permission":
      return addAsk(items, event.toolId, {
        kind: "ask",
        id: event.id,
        ask: {
          kind: "permission",
          title: event.title,
          ...(event.detail ? { detail: event.detail } : {}),
          choices: event.choices,
        },
      });
    case "agent-ask-end": {
      const idx = items.findLastIndex((i) => i.kind === "ask" && i.id === event.id && !i.outcome);
      if (idx === -1) return items;
      const next = items.slice();
      next[idx] = {
        ...(next[idx] as Extract<ChatItem, { kind: "ask" }>),
        outcome: event.outcome,
        ...(event.answers ? { answers: event.answers } : {}),
        ...(event.choiceId ? { choiceId: event.choiceId } : {}),
      };
      return next;
    }
    default:
      return items;
  }
}

/** A card and the tool row it came from are one call, so the card takes the row's place: a
 * one-line "AskUserQuestion" above a card that already asks the question is noise. A later
 * tool-end for that id then finds nothing, which is already a no-op. */
function addAsk(items: ChatItem[], toolId: string | undefined, card: ChatItem): ChatItem[] {
  const at = toolId ? items.findLastIndex((i) => i.kind === "tool" && i.id === toolId) : -1;
  return at === -1 ? [...items, card] : [...items.slice(0, at), ...items.slice(at + 1), card];
}
