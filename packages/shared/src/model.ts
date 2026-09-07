// Domain records shared by daemon, shell and CLI: repos, worktrees, processes, git status, themes.

/** one way to run a repo: which of its procs, with what extra environment */
export interface RunProfile {
  /** keys of ToyonConfig.procs, started in this order */
  procs: string[];
  /** merged into every proc of the profile; `$API_URL` / `${API_URL}` expand to the sibling-URL
   * variables the daemon computes for the procs already up (unknown refs are left as written) */
  env?: Record<string, string>;
  /** preview proc for this profile; must be one of `procs` */
  preview?: string;
}

export interface ToyonConfig {
  /** name -> foreground shell command; must listen on $PORT */
  procs: Record<string, string>;
  /** shell commands run once when a worktree is created */
  setup?: string[];
  /** proc that the preview iframe should show (defaults to "web", else first proc) */
  preview?: string;
  /** commands can't honor $PORT: only the focused worktree's procs run */
  exclusive?: boolean;
  /** named subsets of procs a worktree can run (full stack vs frontend-against-staging) */
  profiles?: Record<string, RunProfile>;
  /** the profile a worktree runs when it has none; required when profiles exist */
  defaultProfile?: string;
}

export interface RepoInfo {
  id: string;
  path: string;
  name: string;
  defaultBranch: string;
  config: ToyonConfig;
  /** config was auto-detected and not yet confirmed by the user */
  needsSetup: boolean;
}

/** one directory offered by the project picker's path completion */
export interface PathEntry {
  /** absolute path, tilde-collapsed for display and for typing back in */
  path: string;
  name: string;
  /** a git repo, so it can be opened as a project; otherwise a folder to descend into */
  isRepo: boolean;
}

export type WorktreeKind = "main" | "worktree" | "spare" | "combined";

export interface WorktreeInfo {
  id: string;
  repoId: string;
  path: string;
  /** a symlink named after the title, beside `path`, when the directory's own name is not the
   * title (a claimed spare keeps its spare-xxxx directory): the terminal's cwd and editor links
   * show this one; git and the procs use `path` */
  linkPath?: string;
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
  /** the shell tab that asked for it (client nonce); that tab focuses it, others don't */
  createdBy?: string;
  /** registry id of the agent working here (stamped at creation, or on first use for older rows) */
  agent?: string;
  /** which of the repo's profiles this worktree runs (the repo's defaultProfile when absent) */
  profile?: string;
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

/** the worktree's own shell, as a stream name. Every other stream is a proc, named by its key in
 * toyon.json, which is why that key cannot be this. */
export const SHELL_STREAM = "shell";

/** how both sides key a stream in their own maps: the ws watch sets, the shell's terminal bus */
export function streamKey(worktreeId: string, stream: string): string {
  return `${worktreeId}/${stream}`;
}

/** one line of a worktree's output, derived from a proc's pty (or emitted by setup and config).
 * The proc name travels beside the text rather than prefixed into it, so only the surface that
 * shows it decides how it reads. */
export interface LogLine {
  proc: string;
  line: string;
}

export type AgentStatus = "idle" | "working" | "error";

/** Who an agent says it is paying as. Both builtin adapters push this over ACP's `_auth/status_update`
 * extension, so it is what the agent itself reports, not what toyon guesses from its files. */
export interface AuthStatus {
  /** none: the agent knows it is logged out. The other kinds each carry a working credential. */
  kind: "none" | "api_key" | "account" | "external" | "gateway";
  /** the agent's own one-line name for it ("Claude Max", "Anthropic API key") */
  label: string;
  /** where the credential comes from (the key's source, the gateway host) */
  detail?: string;
  account?: { email?: string; organization?: string; plan?: string };
}

/** one entry of the daemon's agent registry, as the shell's pickers see it */
export interface AgentInfo {
  id: string;
  name: string;
  /** its launch command resolves on this machine (auth is only discovered on the first prompt) */
  available: boolean;
  /** why not, when unavailable */
  reason?: string;
  /** its adapter is being downloaded right now */
  installing?: boolean;
  /** runs shell commands under an OS sandbox confined to the worktree */
  sandboxed: boolean;
  /** the identity it last reported, from any connection; absent until one has run */
  auth?: AuthStatus;
  /** it advertised ACP's logout method, so settings can offer to sign it out */
  canLogout?: boolean;
}

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
