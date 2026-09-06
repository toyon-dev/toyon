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
  /** set when spawned as one of N parallel attempts at the same prompt */
  variant?: { group: string; index: number; of: number };
  /** open PR created from this worktree (via gh) */
  prUrl?: string;
}

export type ProcStatus = "starting" | "running" | "crashed" | "stopped";

export interface ProcState {
  name: string;
  command: string;
  port: number;
  status: ProcStatus;
  pid?: number;
  exitCode?: number | null;
  /** address family the proc actually listens on (some dev servers bind ::1 only) */
  host?: string;
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
  /** chat messages waiting behind the current turn */
  queued?: number;
}

export interface GitFileStatus {
  path: string;
  /** two-char porcelain XY code, e.g. "M ", " M", "A ", "??" */
  xy: string;
  /** lines added / deleted; absent for binary files and untracked directories */
  add?: number;
  del?: number;
}

// ---- Agent stream events (ACP-shaped) ----

/** display metadata for a picked element attached to a message */
export interface PickMeta {
  component: string | null;
  file: string | null;
  line: number | null;
  tag: string;
  selector: string;
}

export type AgentEvent =
  | { type: "user-message"; text: string; ts: number; pick?: PickMeta }
  | { type: "turn-start"; ts: number }
  | { type: "text-delta"; text: string }
  | { type: "thinking-delta"; text: string }
  | { type: "tool-start"; toolId: string; name: string; input: unknown }
  | { type: "tool-end"; toolId: string; output?: string; isError?: boolean }
  | { type: "turn-end"; stopReason: string; ts: number }
  | { type: "session-info"; sessionId: string; model?: string }
  | { type: "agent-error"; message: string; ts: number }
  | { type: "agent-blocked"; tool: string; path: string; reason: string; ts: number };

// ---- Themes ----

/** always #rrggbb or #rrggbbaa — CSS and Monaco both take 8-digit hex as-is */
export type ThemeColor = string;

export type ThemeSyntaxToken = "comment" | "keyword" | "string" | "number" | "type" | "function" | "variable";

export interface Theme {
  /** "gruvbox-dark-soft" | "file:<slug>" | "vscode:<publisher.ext>:<label-slug>" */
  id: string;
  name: string;
  kind: "dark" | "light";
  /** where it came from — shown as a hint in the picker */
  source: "builtin" | "file" | "vscode";
  colors: {
    bg0: ThemeColor; bg1: ThemeColor; bg2: ThemeColor; bg3: ThemeColor;
    fg1: ThemeColor; fgMuted: ThemeColor; fgDim: ThemeColor;
    red: ThemeColor; orange: ThemeColor; yellow: ThemeColor; green: ThemeColor;
    aqua: ThemeColor; blue: ThemeColor; purple: ThemeColor;
    /** diff line tints (alpha hex) */
    addBg: ThemeColor; delBg: ThemeColor;
    /** overlay backdrop and box-shadow color (alpha hex) */
    scrim: ThemeColor; shadow: ThemeColor;
  };
  /** editor token colors; missing entries inherit Monaco's base theme */
  syntax?: Partial<Record<ThemeSyntaxToken, ThemeColor>>;
  /** id of this theme's opposite-kind sibling (Gruvbox Dark ↔ Gruvbox Light); guessed by name when absent */
  pair?: string;
  /** picker row label shared by a dark/light pair ("Gruvbox"); derived from the name when absent */
  family?: string;
}

export type ThemeColorKey = keyof Theme["colors"];

export interface ThemePrefs {
  /** appearance: paint the `dark` or `light` slot, or follow prefers-color-scheme */
  mode: "dark" | "light" | "system";
  light: string;
  dark: string;
}

// ---- WebSocket protocol ----

/** one content-search match: path + 1-based line + the (trimmed) line text */
export type SearchHit = { path: string; line: number; text: string };

export type ServerMsg =
  | { t: "hello"; version: string; repos: RepoInfo[]; worktrees: WorktreeStatus[]; themes: Theme[]; themePrefs: ThemePrefs }
  | { t: "themes"; themes: Theme[]; prefs: ThemePrefs }
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
  | { t: "search-results"; worktreeId: string; query: string; hits: SearchHit[]; truncated: boolean }
  | { t: "queue"; worktreeId: string; items: string[] }
  | { t: "changed-ranges"; worktreeId: string; path: string; ranges: Array<[number, number]>; lineOffset: number }
  | { t: "error"; message: string };

export type ClientMsg =
  | { t: "subscribe"; worktreeId: string }
  | { t: "chat"; worktreeId: string; text: string; context?: string; pick?: PickMeta }
  | { t: "create-worktree"; repoId: string; prompt: string; baseWorktreeId?: string; variant?: { group: string; index: number; of: number }; context?: string; pick?: PickMeta }
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
  | { t: "search"; worktreeId: string; query: string }
  | { t: "discard-file"; worktreeId: string; path: string }
  | { t: "reveal"; worktreeId: string; path?: string }
  | { t: "stop-agent"; worktreeId: string }
  | { t: "pick-variant"; worktreeId: string }
  | { t: "unqueue"; worktreeId: string; index: number }
  | { t: "changed-ranges"; worktreeId: string; path: string }
  | { t: "rename-worktree"; worktreeId: string; title: string }
  | { t: "confirm-config"; repoId: string; config: OrchardistConfig }
  | { t: "set-theme"; prefs: ThemePrefs }
  /** raw VS Code theme JSON/JSONC text picked in the browser */
  | { t: "import-theme"; name: string; source: string }
  | { t: "rescan-themes" };

export const DAEMON_DEFAULT_PORT = 4141;

export * from "./themes.ts";
export * from "./vscode-theme.ts";
