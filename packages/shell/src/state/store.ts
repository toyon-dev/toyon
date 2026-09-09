// Shell state: one reducer over slices. Pure — no window/localStorage reads in here; main.tsx
// builds the initial state from the browser and passes it in (initialState), which is also why the
// reducer is testable.

import type {
  AgentCommand,
  AgentEvent,
  AgentInfo,
  AskAnswer,
  AskChoice,
  AskOutcome,
  AskQuestion,
  AuthMethodInfo,
  CommitEntry,
  DesignIndex,
  GitFileStatus,
  ImageInput,
  ImageRef,
  LogLine,
  PasteInput,
  PasteRef,
  PathEntry,
  PickedElement,
  PickMeta,
  RepoInfo,
  SearchHit,
  ServerMsg,
  TermServerMsg,
  Theme,
  ThemePrefs,
  ToolKind,
  WorktreeStatus,
} from "@toyon/shared";
import { builtinThemes, defaultThemePrefs, isEditTool, resolveTheme, SHELL_STREAM, toyonDark } from "@toyon/shared";

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
    }
  | { kind: "error"; text: string }
  | { kind: "blocked"; tool: string; path: string; reason: string }
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
}

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
  | { kind: "prompt" }
  | { kind: "keys" }
  /** theme picker: which pref slot Enter writes */
  | { kind: "theme"; slot: "theme" | "light" | "dark" }
  | { kind: "appearance" }
  /** default-agent picker */
  | { kind: "agent" }
  /** the setup pane for a repo that is already configured (install + start commands) */
  | { kind: "setup"; repoId: string }
  /** the project switcher: pick a registered repo, or type a path to open another. It hangs off
   * the pill in the bar; `dialog` is the roomier centered form its browse button opens. */
  | { kind: "projects"; dialog?: boolean };

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

export interface State {
  connected: boolean;
  repos: RepoInfo[];
  worktrees: WorktreeStatus[];
  /** the project the shell is scoped to: the rail, ⌘1–9, ⌘K and settings show only its worktrees.
   * The daemon keeps every repo's procs and agents running regardless; this is a view choice. */
  activeRepoId: string | null;
  /** `worktrees` narrowed to the active repo (kept in step by the reducer so selectors stay stable) */
  visible: WorktreeStatus[];
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
  local: Record<string, WorktreeLocal>;
  /** `ref` set means this is a commit's diff: history, so the editor opens it read-only */
  diff: { worktreeId: string; path: string; before: string; after: string; line?: number; ref?: string } | null;
  toast: { ok: boolean; message: string; url?: string; removeIds?: string[] } | null;
  /** bumped to request a preview reload for a worktree (the edit/HMR decision lives in this reducer) */
  reloadReq: { id: string; n: number } | null;
  /** a file is being dragged over the chat panel, which is the one place a drop attaches */
  dragFiles: boolean;
  /** armed element picker + last picked element (pending chat attachment) */
  picking: boolean;
  pick: (PickedElement & { worktreeId: string }) | null;
  /** a search hit was picked: reveal this line once its file-diff arrives */
  gotoLine: { worktreeId: string; path: string; line: number } | null;
  overlay: Overlay | null;
  /** a sub-picker (theme, appearance) was opened from a palette: esc goes back there with the query restored */
  paletteReturn: { mode: "commands" | "quick-open" | "keys"; q: string } | null;
  /** the daemon speaks another protocol version than this build: stop, ask for a reload */
  incompatible: boolean;
  leftOpen: boolean;
  /** bumped to put the keyboard in the changes list; focus is the DOM's, so this only asks */
  focusLeft: number;
  rightOpen: boolean;
  /** the worktree panel is kept open, instead of peeking on hover and collapsing to the strip */
  railOpen: boolean;
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
  /** the project picker's path completion: directories the daemon found for `query` */
  paths: { query: string; entries: PathEntry[] };
  /** the daemon's agent registry and the default for new worktrees */
  agents: AgentInfo[];
  defaultAgent: string;
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
}

export function initialState(opts: InitialOpts): State {
  const cached = opts.cached ?? toyonDark;
  const state: State = {
    connected: false,
    repos: [],
    worktrees: [],
    activeRepoId: null,
    visible: [],
    lastActive: opts.storedLastActive ?? {},
    pendingOpen: false,
    activeId: null,
    clientId: opts.clientId,
    storedActive: opts.storedActive ?? null,
    storedRepo: opts.storedRepo ?? null,
    local: {},
    diff: null,
    toast: null,
    reloadReq: null,
    dragFiles: false,
    picking: false,
    pick: null,
    gotoLine: null,
    overlay: null,
    paletteReturn: null,
    incompatible: false,
    leftOpen: true,
    focusLeft: 0,
    rightOpen: true,
    railOpen: opts.storedRailOpen ?? false,
    panels: opts.storedPanels ?? {},
    leftAuto: true,
    zen: false,
    termOpen: false,
    designOpen: false,
    themes: builtinThemes.some((t) => t.id === cached.id) ? builtinThemes : [...builtinThemes, cached],
    themePrefs: { ...defaultThemePrefs, mode: cached.kind, [cached.kind]: cached.id },
    previewTheme: null,
    systemDark: opts.systemDark ?? true,
    paths: { query: "", entries: [] },
    agents: [],
    defaultAgent: "claude",
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

export function worktreeById(s: State, id: string | null | undefined): WorktreeStatus | null {
  return (id && s.worktrees.find((w) => w.worktree.id === id)) || null;
}

export function repoById(s: State, id: string | null | undefined): RepoInfo | null {
  return (id && s.repos.find((r) => r.id === id)) || null;
}

/** the active repo's worktrees; every repo's when nothing is selected (a daemon with no repos) */
function visibleOf(worktrees: WorktreeStatus[], repoId: string | null): WorktreeStatus[] {
  return repoId ? worktrees.filter((w) => w.worktree.repoId === repoId) : worktrees;
}

/** the worktree to land on in a repo: the one last selected there, else its first row (main) */
function landingIn(s: State, repoId: string | null, worktrees = s.worktrees): string | null {
  if (!repoId) return worktrees[0]?.worktree.id ?? null;
  const last = s.lastActive[repoId];
  if (last && worktrees.some((w) => w.worktree.id === last)) return last;
  return worktrees.find((w) => w.worktree.repoId === repoId)?.worktree.id ?? null;
}

/** select a worktree, and with it its repo (a chord or a rail click never leaves you scoped to
 * a project that is not the one on screen) */
function activate(s: State, id: string | null): State {
  const wt = worktreeById(s, id);
  const activeRepoId = wt ? wt.worktree.repoId : s.activeRepoId;
  const lastActive = wt ? { ...s.lastActive, [wt.worktree.repoId]: wt.worktree.id } : s.lastActive;
  return { ...s, activeId: id, activeRepoId, lastActive, diff: null };
}

export const isSubPicker = (o: Overlay) => o.kind === "theme" || o.kind === "appearance" || o.kind === "agent";

/** what reaches the reducer: terminal frames are routed to the pane before dispatch (main.tsx) */
export type StoreServerMsg = Exclude<ServerMsg, TermServerMsg>;

export type Action =
  | { a: "server"; msg: StoreServerMsg }
  | { a: "connected"; v: boolean }
  | { a: "activate"; id: string }
  /** switch the shell to another registered repo */
  | { a: "activate-repo"; id: string }
  /** an "open project" request went to the daemon: adopt the repo it adds */
  | { a: "open-repo" }
  | { a: "close-diff" }
  | { a: "dismiss-toast" }
  | { a: "set-draft"; id: string; text: string }
  | { a: "add-images"; id: string; images: PendingImage[] }
  | { a: "remove-image"; id: string; key: string }
  | { a: "clear-images"; id: string }
  | { a: "add-paste"; id: string; paste: PendingPaste }
  | { a: "remove-paste"; id: string; key: string }
  | { a: "clear-pastes"; id: string }
  | { a: "goto-line"; v: State["gotoLine"] }
  | { a: "hmr"; id: string }
  | { a: "page"; id: string; url?: string; title?: string; error?: string; fresh?: boolean }
  | { a: "drag-files"; v: boolean }
  | { a: "set-picking"; v: boolean }
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
  | { a: "toggle-rail" }
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
  if (next.worktrees === s.worktrees && next.activeRepoId === s.activeRepoId) return next;
  return { ...next, visible: visibleOf(next.worktrees, next.activeRepoId) };
}

function reduce(s: State, action: Action): State {
  switch (action.a) {
    case "connected":
      return { ...s, connected: action.v };
    case "activate":
      return activate(s, action.id);
    case "activate-repo": {
      if (action.id === s.activeRepoId || !repoById(s, action.id)) return s;
      const id = landingIn(s, action.id);
      return { ...activate(s, id), activeRepoId: action.id };
    }
    case "open-repo":
      return { ...s, pendingOpen: true };
    case "close-diff":
      return { ...s, diff: null };
    case "dismiss-toast":
      return { ...s, toast: null };
    case "set-draft":
      return withLocal(s, action.id, (l) => ({ ...l, draft: action.text }));
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
    case "goto-line":
      return { ...s, gotoLine: action.v };
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
    case "toggle-rail":
      return { ...s, railOpen: !s.railOpen };
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

/** drop per-worktree records for worktrees the daemon no longer lists */
function pruneLocal(local: State["local"], worktrees: WorktreeStatus[]): State["local"] {
  const keep = new Set(worktrees.map((w) => w.worktree.id));
  if (Object.keys(local).every((id) => keep.has(id))) return local;
  return Object.fromEntries(Object.entries(local).filter(([id]) => keep.has(id)));
}

/** drop the per-project landing spots whose worktree is gone; the fallback is that project's main
 * either way, this just keeps dead ids out of storage */
function pruneLastActive(lastActive: Record<string, string>, worktrees: WorktreeStatus[]): Record<string, string> {
  const keep = new Set(worktrees.map((w) => w.worktree.id));
  if (Object.values(lastActive).every((id) => keep.has(id))) return lastActive;
  return Object.fromEntries(Object.entries(lastActive).filter(([, id]) => keep.has(id)));
}

function onServer(s: State, msg: StoreServerMsg): State {
  switch (msg.t) {
    case "hello": {
      // restore the previously selected worktree across reloads
      const has = (id: string | null) => !!id && msg.worktrees.some((w) => w.worktree.id === id);
      const hasRepo = (id: string | null) => !!id && msg.repos.some((r) => r.id === id);
      // the project narrows the fallback: a stored repo whose stored worktree is gone still opens
      // on that repo, not on whichever worktree the daemon lists first
      const repoId = hasRepo(s.activeRepoId) ? s.activeRepoId : hasRepo(s.storedRepo) ? s.storedRepo : null;
      const activeId = has(s.activeId)
        ? s.activeId
        : has(s.storedActive)
          ? s.storedActive
          : landingIn(s, repoId, msg.worktrees);
      const wt = msg.worktrees.find((w) => w.worktree.id === activeId);
      return {
        ...s,
        repos: msg.repos,
        worktrees: msg.worktrees,
        activeId,
        activeRepoId: wt?.worktree.repoId ?? repoId ?? msg.repos[0]?.id ?? null,
        local: pruneLocal(s.local, msg.worktrees),
        lastActive: pruneLastActive(s.lastActive, msg.worktrees),
        themes: msg.themes ?? s.themes,
        themePrefs: msg.themePrefs ?? s.themePrefs,
        agents: msg.agents,
        defaultAgent: msg.defaultAgent,
      };
    }
    case "themes":
      return { ...s, themes: msg.themes, themePrefs: msg.prefs };
    case "agents":
      return { ...s, agents: msg.agents, defaultAgent: msg.defaultAgent };
    case "path-entries":
      return { ...s, paths: { query: msg.query, entries: msg.entries } };
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
      return { ...s, repos: msg.repos, pendingOpen, activeRepoId, activeId: landingIn(s, activeRepoId), diff: null };
    }
    case "worktrees": {
      let activeId = s.activeId;
      if (!activeId || !msg.worktrees.some((w) => w.worktree.id === activeId)) {
        activeId = landingIn(s, s.activeRepoId, msg.worktrees);
      }
      // auto-focus a worktree THIS tab just created (the "prompt spawns a tab" moment); one made
      // from another tab or the CLI stays where it is
      const known = new Set(s.worktrees.map((w) => w.worktree.id));
      const fresh = msg.worktrees.find(
        (w) => !known.has(w.worktree.id) && w.worktree.kind === "worktree" && w.worktree.createdBy === s.clientId,
      );
      if (fresh && s.worktrees.length > 0) activeId = fresh.worktree.id;
      return activate({ ...s, worktrees: msg.worktrees, local: pruneLocal(s.local, msg.worktrees) }, activeId);
    }
    case "proc": {
      const worktrees = s.worktrees.map((w) =>
        w.worktree.id === msg.worktreeId ? { ...w, procs: upsertProc(w.procs, msg.proc) } : w,
      );
      return { ...s, worktrees };
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
        return { ...l, chat, turn };
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
      for (const { event } of msg.events) chat = applyEvent(chat, event);
      return withLocal(s, msg.worktreeId, (l) => ({ ...l, chat, log: msg.log ?? l.log }));
    }
    case "git-status": {
      // session opened on a clean main: nothing to show — close the changes panel once
      let leftOpen = s.leftOpen;
      let leftAuto = s.leftAuto;
      if (s.leftAuto && msg.worktreeId === s.activeId) {
        const wt = s.worktrees.find((w) => w.worktree.id === msg.worktreeId);
        if (wt?.worktree.kind === "main" && msg.files.length === 0 && (msg.committed?.length ?? 0) === 0) {
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
    case "changed-ranges":
      return withLocal(s, msg.worktreeId, (l) => ({
        ...l,
        changedRanges: { ...l.changedRanges, [msg.path]: { ranges: msg.ranges, offset: msg.lineOffset } },
      }));
    case "file-diff": {
      const g = s.gotoLine;
      const line = g && g.worktreeId === msg.worktreeId && g.path === msg.path ? g.line : undefined;
      return { ...s, diff: { ...msg, line }, gotoLine: null };
    }
    case "shipped": {
      // a suggestion lands in that worktree's composer and focuses it
      const next = msg.suggestion
        ? withLocal(activate(s, msg.worktreeId), msg.worktreeId, (l) => ({ ...l, draft: msg.suggestion! }))
        : s;
      return {
        ...next,
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
      return { ...s, toast: { ok: false, message: msg.message } };
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

export function applyEvent(items: ChatItem[], event: AgentEvent): ChatItem[] {
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
