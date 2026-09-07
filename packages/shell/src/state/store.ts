// Shell state: one reducer over slices. Pure — no window/localStorage reads in here; main.tsx
// builds the initial state from the browser and passes it in (initialState), which is also why the
// reducer is testable.

import type {
  AgentEvent,
  AgentInfo,
  AuthMethodInfo,
  GitFileStatus,
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
import { builtinThemes, defaultThemePrefs, gruvboxDarkSoft, isEditTool, resolveTheme } from "@toyon/shared";

export type ChatItem =
  | { kind: "user"; text: string; pick?: PickMeta }
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
  /** the agent wants credentials; `done` once a login went through */
  | { kind: "auth"; agent: string; agentName: string; methods: AuthMethodInfo[]; done: boolean };

export interface GitInfo {
  files: GitFileStatus[];
  committed?: GitFileStatus[];
  ahead?: number;
  behind?: number;
}

/** everything the shell tracks for one worktree; dropped when the worktree disappears */
export interface WorktreeLocal {
  chat: ChatItem[];
  log: string[];
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
  /** ⌘⇧F results */
  search: { query: string; hits: SearchHit[]; truncated: boolean } | null;
  /** the composer's unsent text; survives switching worktrees, and is where the daemon's
   * conflict-resolution suggestion lands */
  draft: string;
}

export const EMPTY_LOCAL: WorktreeLocal = Object.freeze({
  chat: [],
  log: [],
  queue: [],
  page: { errors: [] },
  turn: { edits: false, hmr: false },
  changedRanges: {},
  search: null,
  draft: "",
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
  | { kind: "agent" };

export interface State {
  connected: boolean;
  repos: RepoInfo[];
  worktrees: WorktreeStatus[];
  activeId: string | null;
  /** this tab's id; a worktree created from here steals focus, one created elsewhere does not */
  clientId: string;
  /** worktree selected before the last reload, restored on hello */
  storedActive: string | null;
  local: Record<string, WorktreeLocal>;
  diff: { worktreeId: string; path: string; before: string; after: string; line?: number } | null;
  toast: { ok: boolean; message: string; url?: string; removeIds?: string[] } | null;
  /** bumped to request a preview reload for a worktree (the edit/HMR decision lives in this reducer) */
  reloadReq: { id: string; n: number } | null;
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
  rightOpen: boolean;
  /** one-shot: auto-close the changes panel if the session starts on a clean main */
  leftAuto: boolean;
  /** full-bleed preview: all chrome hidden */
  zen: boolean;
  /** the terminal pane under the preview (one per worktree; the shells keep running when hidden) */
  termOpen: boolean;
  /** themes the daemon knows (built-ins, ~/.toyon/themes, installed editors) + the selection */
  themes: Theme[];
  themePrefs: ThemePrefs;
  /** picker highlight, applied live while browsing */
  previewTheme: Theme | null;
  /** OS appearance (prefers-color-scheme), for themePrefs.mode === "system" */
  systemDark: boolean;
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
}

export function initialState(opts: InitialOpts): State {
  const cached = opts.cached ?? gruvboxDarkSoft;
  return {
    connected: false,
    repos: [],
    worktrees: [],
    activeId: null,
    clientId: opts.clientId,
    storedActive: opts.storedActive ?? null,
    local: {},
    diff: null,
    toast: null,
    reloadReq: null,
    picking: false,
    pick: null,
    gotoLine: null,
    overlay: null,
    paletteReturn: null,
    incompatible: false,
    leftOpen: true,
    rightOpen: true,
    leftAuto: true,
    zen: false,
    termOpen: false,
    themes: builtinThemes.some((t) => t.id === cached.id) ? builtinThemes : [...builtinThemes, cached],
    themePrefs: { ...defaultThemePrefs, mode: cached.kind, [cached.kind]: cached.id },
    previewTheme: null,
    systemDark: opts.systemDark ?? true,
    agents: [],
    defaultAgent: "claude",
  };
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

export const isSubPicker = (o: Overlay) => o.kind === "theme" || o.kind === "appearance" || o.kind === "agent";

/** what reaches the reducer: terminal frames are routed to the pane before dispatch (main.tsx) */
export type StoreServerMsg = Exclude<ServerMsg, TermServerMsg>;

export type Action =
  | { a: "server"; msg: StoreServerMsg }
  | { a: "connected"; v: boolean }
  | { a: "activate"; id: string }
  | { a: "close-diff" }
  | { a: "dismiss-toast" }
  | { a: "set-draft"; id: string; text: string }
  | { a: "goto-line"; v: State["gotoLine"] }
  | { a: "hmr"; id: string }
  | { a: "page"; id: string; url?: string; title?: string; error?: string; fresh?: boolean }
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
  | { a: "toggle-right" }
  | { a: "toggle-zen" }
  | { a: "toggle-terminal" }
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

export function reducer(s: State, action: Action): State {
  switch (action.a) {
    case "connected":
      return { ...s, connected: action.v };
    case "activate":
      return { ...s, activeId: action.id, diff: null };
    case "close-diff":
      return { ...s, diff: null };
    case "dismiss-toast":
      return { ...s, toast: null };
    case "set-draft":
      return withLocal(s, action.id, (l) => ({ ...l, draft: action.text }));
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
    case "toggle-right":
      return { ...s, rightOpen: !s.rightOpen };
    case "toggle-zen":
      return { ...s, zen: !s.zen, toast: !s.zen ? { ok: true, message: "esc or ⌘. to exit" } : s.toast };
    case "toggle-terminal":
      return { ...s, termOpen: !s.termOpen };
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

function onServer(s: State, msg: StoreServerMsg): State {
  switch (msg.t) {
    case "hello": {
      // restore the previously selected worktree across reloads
      const has = (id: string | null) => !!id && msg.worktrees.some((w) => w.worktree.id === id);
      const activeId = has(s.activeId)
        ? s.activeId
        : has(s.storedActive)
          ? s.storedActive
          : (msg.worktrees[0]?.worktree.id ?? null);
      return {
        ...s,
        repos: msg.repos,
        worktrees: msg.worktrees,
        activeId,
        local: pruneLocal(s.local, msg.worktrees),
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
    case "repos":
      return { ...s, repos: msg.repos };
    case "worktrees": {
      let activeId = s.activeId;
      if (!activeId || !msg.worktrees.some((w) => w.worktree.id === activeId)) {
        activeId = msg.worktrees[0]?.worktree.id ?? null;
      }
      // auto-focus a worktree THIS tab just created (the "prompt spawns a tab" moment); one made
      // from another tab or the CLI stays where it is
      const known = new Set(s.worktrees.map((w) => w.worktree.id));
      const fresh = msg.worktrees.find(
        (w) => !known.has(w.worktree.id) && w.worktree.kind === "worktree" && w.worktree.createdBy === s.clientId,
      );
      if (fresh && s.worktrees.length > 0) activeId = fresh.worktree.id;
      return { ...s, worktrees: msg.worktrees, activeId, local: pruneLocal(s.local, msg.worktrees) };
    }
    case "proc": {
      const worktrees = s.worktrees.map((w) =>
        w.worktree.id === msg.worktreeId ? { ...w, procs: upsertProc(w.procs, msg.proc) } : w,
      );
      return { ...s, worktrees };
    }
    case "log":
      return withLocal(s, msg.worktreeId, (l) => ({ ...l, log: [...l.log.slice(-400), `[${msg.proc}] ${msg.line}`] }));
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
        git: { files: msg.files, committed: msg.committed, ahead: msg.ahead, behind: msg.behind },
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
        ? withLocal({ ...s, activeId: msg.worktreeId }, msg.worktreeId, (l) => ({ ...l, draft: msg.suggestion! }))
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
    case "queue":
      return withLocal(s, msg.worktreeId, (l) => ({ ...l, queue: msg.items }));
    case "error":
      return { ...s, toast: { ok: false, message: msg.message } };
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
      return [...items, { kind: "user", text: event.text, pick: event.pick }];
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
        { kind: "auth", agent: event.agent, agentName: event.agentName, methods: event.methods, done: false },
      ];
    case "agent-auth-ok": {
      const idx = items.findLastIndex((i) => i.kind === "auth" && !i.done);
      if (idx === -1) return items;
      const next = items.slice();
      next[idx] = { ...(next[idx] as Extract<ChatItem, { kind: "auth" }>), done: true };
      return next;
    }
    default:
      return items;
  }
}
