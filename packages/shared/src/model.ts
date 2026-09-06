// Domain records shared by daemon, shell and CLI: repos, worktrees, processes, git status, themes.

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
    bg0: ThemeColor;
    bg1: ThemeColor;
    bg2: ThemeColor;
    bg3: ThemeColor;
    fg1: ThemeColor;
    fgMuted: ThemeColor;
    fgDim: ThemeColor;
    red: ThemeColor;
    orange: ThemeColor;
    yellow: ThemeColor;
    green: ThemeColor;
    aqua: ThemeColor;
    blue: ThemeColor;
    purple: ThemeColor;
    /** diff line tints (alpha hex) */
    addBg: ThemeColor;
    delBg: ThemeColor;
    /** overlay backdrop and box-shadow color (alpha hex) */
    scrim: ThemeColor;
    shadow: ThemeColor;
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
