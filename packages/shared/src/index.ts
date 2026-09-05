// Shared protocol types between daemon, shell, and CLI.
// Agent event shapes are modeled on ACP (Agent Client Protocol) semantics so a
// generic ACP adapter can slot in later without changing the wire protocol.

export interface OrchardistConfig {
  /** name -> foreground shell command; must listen on $PORT */
  procs: Record<string, string>;
  /** shell commands run once when a worktree is created */
  setup?: string[];
  /** proc that the preview iframe should show (defaults to "web", else first proc) */
  preview?: string;
  /** commands can't honor $PORT: only the focused worktree's procs run */
  exclusive?: boolean;
}

export interface RepoInfo {
  id: string;
  path: string;
  name: string;
  defaultBranch: string;
  config: OrchardistConfig;
  /** config was auto-detected and not yet confirmed by the user */
  needsSetup: boolean;
}

export type WorktreeKind = "main" | "worktree" | "spare" | "combined";

export interface WorktreeInfo {
  id: string;
  repoId: string;
  path: string;
  branch: string;
  kind: WorktreeKind;
  /** port of this worktree's reverse proxy (preview iframe target) */
  proxyPort: number;
  title: string;
  createdAt: number;
  /** merged into main and no new work since */
  landed?: boolean;
  /** for kind "combined": the worktrees this graft was made from */
  sources?: string[];
}

export type ProcStatus = "starting" | "running" | "crashed" | "stopped";

export interface ProcState {
  name: string;
  command: string;
  port: number;
  status: ProcStatus;
  pid?: number;
  exitCode?: number | null;
}

export type AgentStatus = "idle" | "working" | "error";

export interface WorktreeStatus {
  worktree: WorktreeInfo;
  procs: ProcState[];
  agent: AgentStatus;
  /** commits ahead/behind the default branch (cached, ~10s freshness) */
  ahead?: number;
  behind?: number;
  /** uncommitted file count (cached, ~10s freshness) */
  dirty?: number;
}

export interface GitFileStatus {
  path: string;
  /** two-char porcelain XY code, e.g. "M ", " M", "A ", "??" */
  xy: string;
}

// ---- Agent stream events (ACP-shaped) ----

export type AgentEvent =
  | { type: "user-message"; text: string; ts: number }
  | { type: "turn-start"; ts: number }
  | { type: "text-delta"; text: string }
  | { type: "thinking-delta"; text: string }
  | { type: "tool-start"; toolId: string; name: string; input: unknown }
  | { type: "tool-end"; toolId: string; output?: string; isError?: boolean }
  | { type: "turn-end"; stopReason: string; ts: number }
  | { type: "session-info"; sessionId: string; model?: string }
  | { type: "agent-error"; message: string; ts: number };

// ---- WebSocket protocol ----

export type ServerMsg =
  | { t: "hello"; version: string; repos: RepoInfo[]; worktrees: WorktreeStatus[] }
  | { t: "repos"; repos: RepoInfo[] }
  | { t: "worktrees"; worktrees: WorktreeStatus[] }
  | { t: "proc"; worktreeId: string; proc: ProcState }
  | { t: "log"; worktreeId: string; proc: string; line: string }
  | { t: "agent"; worktreeId: string; seq: number; event: AgentEvent }
  | { t: "backfill"; worktreeId: string; events: Array<{ seq: number; event: AgentEvent }> }
  | { t: "git-status"; worktreeId: string; files: GitFileStatus[]; committed?: GitFileStatus[]; ahead?: number; behind?: number }
  | { t: "file-diff"; worktreeId: string; path: string; before: string; after: string }
  | { t: "shipped"; worktreeId: string; ok: boolean; url?: string; message: string; merged?: boolean; removeIds?: string[]; suggestion?: string }
  | { t: "files"; worktreeId: string; paths: string[] }
  | { t: "error"; message: string };

export type ClientMsg =
  | { t: "subscribe"; worktreeId: string }
  | { t: "chat"; worktreeId: string; text: string }
  | { t: "create-worktree"; repoId: string; prompt: string; baseWorktreeId?: string }
  | { t: "batch-worktrees"; repoId: string; prompt: string }
  | { t: "remove-worktree"; worktreeId: string }
  | { t: "restart-proc"; worktreeId: string; proc: string }
  | { t: "git-status"; worktreeId: string }
  | { t: "file-diff"; worktreeId: string; path: string }
  | { t: "ship"; worktreeId: string }
  | { t: "merge-main"; worktreeId: string }
  | { t: "commit"; worktreeId: string; message: string }
  | { t: "combine"; worktreeIds: string[] }
  | { t: "sync-main"; worktreeId: string }
  | { t: "write-file"; worktreeId: string; path: string; content: string }
  | { t: "list-files"; worktreeId: string }
  | { t: "discard-file"; worktreeId: string; path: string }
  | { t: "reveal"; worktreeId: string; path?: string }
  | { t: "rename-worktree"; worktreeId: string; title: string }
  | { t: "confirm-config"; repoId: string; config: OrchardistConfig };

export const DAEMON_DEFAULT_PORT = 4141;
