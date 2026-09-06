import type {
  AgentEvent, GitFileStatus, RepoInfo, SearchHit, ServerMsg, WorktreeStatus,
} from "@orchardist/shared";

export type ChatItem =
  | { kind: "user"; text: string; pick?: import("@orchardist/shared").PickMeta }
  | { kind: "assistant"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown; output?: string; isError?: boolean; done: boolean }
  | { kind: "error"; text: string }
  | { kind: "blocked"; tool: string; path: string; reason: string };

export interface State {
  connected: boolean;
  repos: RepoInfo[];
  worktrees: WorktreeStatus[];
  activeId: string | null;
  chats: Record<string, ChatItem[]>;
  git: Record<string, { files: GitFileStatus[]; committed?: GitFileStatus[]; ahead?: number; behind?: number }>;
  logs: Record<string, string[]>;
  diff: { worktreeId: string; path: string; before: string; after: string; line?: number } | null;
  toast: { ok: boolean; message: string; url?: string; removeIds?: string[] } | null;
  prefill: { worktreeId: string; text: string } | null;
  files: Record<string, string[]>;
  queues: Record<string, string[]>;
  /** per-worktree: did the current agent turn edit anything / did the page HMR */
  turnEdits: Record<string, boolean>;
  turnHmr: Record<string, boolean>;
  /** bumped to request a preview reload for a worktree */
  reloadReq: { id: string; n: number } | null;
  /** live page state per worktree (route, title, recent errors) — ambient chat context */
  pageCtx: Record<string, { url?: string; title?: string; errors: string[] }>;
  /** armed element picker + last picked element (pending chat attachment) */
  picking: boolean;
  pick: {
    worktreeId: string;
    component: string | null;
    file: string | null;
    line: number | null;
    tag: string;
    classes: string;
    text: string;
    html: string;
    route: string;
    selector: string;
  } | null;
  /** changed line ranges cache, keyed `${worktreeId}:${path}` */
  changedRanges: Record<string, { ranges: Array<[number, number]>; offset: number }>;
  showQuickOpen: boolean;
  /** ⌘⇧F content search palette + last results for the active worktree */
  showSearch: boolean;
  search: { worktreeId: string; query: string; hits: SearchHit[]; truncated: boolean } | null;
  /** a search hit was picked: reveal this line once its file-diff arrives */
  gotoLine: { worktreeId: string; path: string; line: number } | null;
  showPrompt: boolean;
  leftOpen: boolean;
  rightOpen: boolean;
  /** one-shot: auto-close the changes panel if the session starts on a clean main */
  leftAuto: boolean;
  /** full-bleed preview: all chrome hidden */
  zen: boolean;
  /** keyboard shortcuts overlay (⌘/ or the ? button) */
  showKeys: boolean;
  /** ⌘⇧E command palette */
  showCommands: boolean;
}

export const initial: State = {
  connected: false,
  repos: [],
  worktrees: [],
  activeId: null,
  chats: {},
  git: {},
  logs: {},
  diff: null,
  toast: null,
  prefill: null,
  files: {},
  queues: {},
  turnEdits: {},
  turnHmr: {},
  reloadReq: null,
  pageCtx: {},
  picking: false,
  pick: null,
  changedRanges: {},
  showQuickOpen: false,
  showSearch: false,
  search: null,
  gotoLine: null,
  showPrompt: false,
  leftOpen: true,
  rightOpen: true,
  leftAuto: true,
  zen: false,
  showKeys: false,
  showCommands: false,
};

export type Action =
  | { a: "server"; msg: ServerMsg }
  | { a: "connected"; v: boolean }
  | { a: "activate"; id: string }
  | { a: "close-diff" }
  | { a: "dismiss-toast" }
  | { a: "clear-prefill" }
  | { a: "quick-open"; v: boolean }
  | { a: "show-search"; v: boolean }
  | { a: "goto-line"; v: { worktreeId: string; path: string; line: number } | null }
  | { a: "hmr"; id: string }
  | { a: "page"; id: string; url?: string; title?: string; error?: string; fresh?: boolean }
  | { a: "set-picking"; v: boolean }
  | { a: "picked"; pick: NonNullable<State["pick"]> }
  | { a: "clear-pick" }
  | { a: "show-prompt"; v: boolean }
  | { a: "toggle-left" }
  | { a: "toggle-right" }
  | { a: "toggle-zen" }
  | { a: "show-keys"; v: boolean }
  | { a: "show-commands"; v: boolean };

/** the modal overlays are mutually exclusive: opening one closes the others */
const NO_OVERLAYS = { showQuickOpen: false, showSearch: false, showPrompt: false, showKeys: false, showCommands: false } as const;

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
    case "clear-prefill":
      return { ...s, prefill: null };
    case "quick-open":
      return { ...s, ...(action.v ? NO_OVERLAYS : {}), showQuickOpen: action.v };
    case "show-search":
      return { ...s, ...(action.v ? NO_OVERLAYS : {}), showSearch: action.v };
    case "goto-line":
      return { ...s, gotoLine: action.v };
    case "hmr":
      return { ...s, turnHmr: { ...s.turnHmr, [action.id]: true } };
    case "page": {
      const cur = s.pageCtx[action.id] ?? { errors: [] };
      const next = {
        url: action.url ?? cur.url,
        title: action.title ?? cur.title,
        errors: action.fresh ? [] : action.error ? [...cur.errors.slice(-2), action.error] : cur.errors,
      };
      return { ...s, pageCtx: { ...s.pageCtx, [action.id]: next } };
    }
    case "set-picking":
      return { ...s, picking: action.v };
    case "picked":
      return { ...s, picking: false, pick: action.pick };
    case "clear-pick":
      return { ...s, pick: null };
    case "show-prompt":
      return { ...s, ...(action.v ? NO_OVERLAYS : {}), showPrompt: action.v };
    case "toggle-left":
      return { ...s, leftOpen: !s.leftOpen, leftAuto: false };
    case "toggle-right":
      return { ...s, rightOpen: !s.rightOpen };
    case "toggle-zen":
      return {
        ...s,
        zen: !s.zen,
        toast: !s.zen ? { ok: true, message: "esc or ⌘. to exit" } : s.toast,
      };
    case "show-keys":
      return { ...s, ...(action.v ? NO_OVERLAYS : {}), showKeys: action.v };
    case "show-commands":
      return { ...s, ...(action.v ? NO_OVERLAYS : {}), showCommands: action.v };
    case "server":
      return onServer(s, action.msg);
  }
}

function onServer(s: State, msg: ServerMsg): State {
  switch (msg.t) {
    case "hello": {
      // restore the previously selected worktree across reloads
      let stored: string | null = null;
      try {
        stored = localStorage.getItem("orch-active");
      } catch {}
      const activeId =
        s.activeId && msg.worktrees.some((w) => w.worktree.id === s.activeId)
          ? s.activeId
          : stored && msg.worktrees.some((w) => w.worktree.id === stored)
            ? stored
            : msg.worktrees[0]?.worktree.id ?? null;
      return { ...s, repos: msg.repos, worktrees: msg.worktrees, activeId };
    }
    case "repos":
      return { ...s, repos: msg.repos };
    case "worktrees": {
      let activeId = s.activeId;
      if (!activeId || !msg.worktrees.some((w) => w.worktree.id === activeId)) {
        activeId = msg.worktrees[0]?.worktree.id ?? null;
      }
      // auto-focus a brand-new worktree (the "prompt spawns a tab" moment)
      const known = new Set(s.worktrees.map((w) => w.worktree.id));
      const fresh = msg.worktrees.find((w) => !known.has(w.worktree.id) && w.worktree.kind === "worktree");
      if (fresh && s.worktrees.length > 0) activeId = fresh.worktree.id;
      return { ...s, worktrees: msg.worktrees, activeId };
    }
    case "proc": {
      const worktrees = s.worktrees.map((w) =>
        w.worktree.id === msg.worktreeId
          ? { ...w, procs: upsertProc(w.procs, msg.proc) }
          : w,
      );
      return { ...s, worktrees };
    }
    case "log": {
      const cur = s.logs[msg.worktreeId] ?? [];
      const next = [...cur.slice(-400), `[${msg.proc}] ${msg.line}`];
      return { ...s, logs: { ...s.logs, [msg.worktreeId]: next } };
    }
    case "agent": {
      const items = applyEvent(s.chats[msg.worktreeId] ?? [], msg.event);
      let next: State = { ...s, chats: { ...s.chats, [msg.worktreeId]: items } };
      const ev = msg.event;
      const id = msg.worktreeId;
      if (ev.type === "turn-start") {
        next = {
          ...next,
          turnEdits: { ...next.turnEdits, [id]: false },
          turnHmr: { ...next.turnHmr, [id]: false },
        };
      } else if (ev.type === "tool-start" && ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"].includes(ev.name)) {
        next = { ...next, turnEdits: { ...next.turnEdits, [id]: true } };
      } else if (ev.type === "turn-end") {
        // edits happened but nothing hot-updated: the change is outside HMR's
        // reach (backend/data) — ask the preview to reload itself
        if (next.turnEdits[id] && !next.turnHmr[id]) {
          next = { ...next, reloadReq: { id, n: (next.reloadReq?.n ?? 0) + 1 } };
        }
      }
      return next;
    }
    case "backfill": {
      let items: ChatItem[] = [];
      for (const { event } of msg.events) items = applyEvent(items, event);
      return { ...s, chats: { ...s.chats, [msg.worktreeId]: items } };
    }
    case "git-status": {
      // ranges go stale whenever the worktree's git state moves
      const changedRanges = Object.fromEntries(
        Object.entries(s.changedRanges).filter(([k]) => !k.startsWith(msg.worktreeId + ":")),
      );
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
      return {
        ...s,
        leftOpen,
        leftAuto,
        changedRanges,
        git: {
          ...s.git,
          [msg.worktreeId]: { files: msg.files, committed: msg.committed, ahead: msg.ahead, behind: msg.behind },
        },
      };
    }
    case "changed-ranges":
      return {
        ...s,
        changedRanges: {
          ...s.changedRanges,
          [`${msg.worktreeId}:${msg.path}`]: { ranges: msg.ranges, offset: msg.lineOffset },
        },
      };
    case "file-diff": {
      const g = s.gotoLine;
      const line = g && g.worktreeId === msg.worktreeId && g.path === msg.path ? g.line : undefined;
      return { ...s, diff: { ...msg, line }, gotoLine: null };
    }
    case "shipped":
      return {
        ...s,
        // a suggestion prefills that worktree's chat and focuses it
        activeId: msg.suggestion ? msg.worktreeId : s.activeId,
        prefill: msg.suggestion ? { worktreeId: msg.worktreeId, text: msg.suggestion } : s.prefill,
        toast: {
          ok: msg.ok,
          message: msg.message,
          url: msg.url,
          removeIds: msg.merged && msg.ok ? msg.removeIds ?? [msg.worktreeId] : undefined,
        },
      };
    case "files":
      return { ...s, files: { ...s.files, [msg.worktreeId]: msg.paths } };
    case "search-results":
      return { ...s, search: { worktreeId: msg.worktreeId, query: msg.query, hits: msg.hits, truncated: msg.truncated } };
    case "queue":
      return { ...s, queues: { ...s.queues, [msg.worktreeId]: msg.items } };
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

function applyEvent(items: ChatItem[], event: AgentEvent): ChatItem[] {
  const last = items[items.length - 1];
  switch (event.type) {
    case "user-message":
      return [...items, { kind: "user", text: event.text, pick: event.pick }];
    case "text-delta":
      if (last?.kind === "assistant") {
        return [...items.slice(0, -1), { ...last, text: last.text + event.text }];
      }
      return [...items, { kind: "assistant", text: event.text }];
    case "thinking-delta":
      if (last?.kind === "thinking") {
        return [...items.slice(0, -1), { ...last, text: last.text + event.text }];
      }
      return [...items, { kind: "thinking", text: event.text }];
    case "tool-start":
      return [...items, { kind: "tool", id: event.toolId, name: event.name, input: event.input, done: false }];
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
    default:
      return items;
  }
}
