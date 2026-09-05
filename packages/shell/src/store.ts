import type {
  AgentEvent, GitFileStatus, RepoInfo, ServerMsg, WorktreeStatus,
} from "@orchardist/shared";

export type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown; output?: string; isError?: boolean; done: boolean }
  | { kind: "error"; text: string };

export interface State {
  connected: boolean;
  repos: RepoInfo[];
  worktrees: WorktreeStatus[];
  activeId: string | null;
  chats: Record<string, ChatItem[]>;
  git: Record<string, { files: GitFileStatus[]; committed?: GitFileStatus[]; ahead?: number; behind?: number }>;
  logs: Record<string, string[]>;
  diff: { worktreeId: string; path: string; before: string; after: string } | null;
  toast: { ok: boolean; message: string; url?: string; removeIds?: string[] } | null;
  prefill: { worktreeId: string; text: string } | null;
  files: Record<string, string[]>;
  queues: Record<string, string[]>;
  showQuickOpen: boolean;
  showPrompt: boolean;
  leftOpen: boolean;
  rightOpen: boolean;
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
  showQuickOpen: false,
  showPrompt: false,
  leftOpen: true,
  rightOpen: true,
};

export type Action =
  | { a: "server"; msg: ServerMsg }
  | { a: "connected"; v: boolean }
  | { a: "activate"; id: string }
  | { a: "close-diff" }
  | { a: "dismiss-toast" }
  | { a: "clear-prefill" }
  | { a: "quick-open"; v: boolean }
  | { a: "show-prompt"; v: boolean }
  | { a: "toggle-left" }
  | { a: "toggle-right" };

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
      return { ...s, showQuickOpen: action.v };
    case "show-prompt":
      return { ...s, showPrompt: action.v };
    case "toggle-left":
      return { ...s, leftOpen: !s.leftOpen };
    case "toggle-right":
      return { ...s, rightOpen: !s.rightOpen };
    case "server":
      return onServer(s, action.msg);
  }
}

function onServer(s: State, msg: ServerMsg): State {
  switch (msg.t) {
    case "hello": {
      const activeId =
        s.activeId && msg.worktrees.some((w) => w.worktree.id === s.activeId)
          ? s.activeId
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
      return { ...s, chats: { ...s.chats, [msg.worktreeId]: items } };
    }
    case "backfill": {
      let items: ChatItem[] = [];
      for (const { event } of msg.events) items = applyEvent(items, event);
      return { ...s, chats: { ...s.chats, [msg.worktreeId]: items } };
    }
    case "git-status":
      return {
        ...s,
        git: {
          ...s.git,
          [msg.worktreeId]: { files: msg.files, committed: msg.committed, ahead: msg.ahead, behind: msg.behind },
        },
      };
    case "file-diff":
      return { ...s, diff: msg };
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
      return [...items, { kind: "user", text: event.text }];
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
    default:
      return items;
  }
}
