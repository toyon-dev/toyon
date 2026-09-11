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
  /** the file the unconfirmed guess was read from, relative to the root (package.json, start.sh):
   * the setup pane opens it so the person can copy the script they meant. Gone once confirmed. */
  guess?: string;
}

/** one directory offered by the project picker's path completion */
export interface PathEntry {
  /** absolute path, tilde-collapsed for display and for typing back in */
  path: string;
  name: string;
  /** a git repo, so it can be opened as a project; otherwise a folder to descend into */
  isRepo: boolean;
}

/** what the picker's typed path *is*, as opposed to what is inside it. Without this the picker
 * cannot tell "no such folder" from "folder with nothing matching yet": both arrive as an empty
 * entry list, and only one of them is somewhere a project could be made. */
export interface PathTarget {
  /** the typed path itself exists */
  exists: boolean;
  isDir: boolean;
  isRepo: boolean;
  /** its parent exists, which is what decides whether one new folder may be made here */
  parentExists: boolean;
}

/** A project being cloned: it has no RepoInfo yet (no path, no branch, no config), but it is a real
 * thing the person started and should be able to watch and stop. Held by the daemon rather than the
 * tab that asked, so every tab sees it and a reload does not lose it. */
export interface PendingRepo {
  id: string;
  name: string;
  /** where it is being cloned into */
  parent: string;
  url: string;
  startedAt: number;
  /** git's own progress output, most recent last and capped: enough to see it moving */
  lines: string[];
  /** set when it failed. The record stays so the reason is still there to read, since a toast
   * would be gone before someone who walked away from a long clone came back to it. */
  error?: string;
}

export type WorktreeKind = "main" | "worktree" | "spare";

/** How much the agent may do in a worktree without a person in the loop. Agent-neutral: the
 * daemon maps each onto the agent's own session mode and its permission policy.
 * - `auto`: the default. Every write inside the worktree and every sandboxed command runs; a
 *   write outside is refused; a plan is the one thing that waits for approval.
 * - `ask`: every write and every shell command is a card in the chat before it runs.
 * - `plan`: the agent reads and proposes only; the plan is a card, and approving it decides the
 *   mode the work is done in. */
export type PermissionMode = "auto" | "ask" | "plan";
export const PERMISSION_MODES: ReadonlyArray<{ id: PermissionMode; name: string; description: string }> = [
  { id: "auto", name: "auto", description: "edits and sandboxed commands run; a plan still asks" },
  { id: "ask", name: "ask", description: "every edit and command is a card before it runs" },
  { id: "plan", name: "plan", description: "read and propose only; approving the plan starts the work" },
];
export const DEFAULT_PERMISSION_MODE: PermissionMode = "auto";

export interface WorktreeInfo {
  id: string;
  repoId: string;
  path: string;
  /** a symlink named after the title, beside `path`, when the directory's own name is not the
   * title (a claimed spare keeps its wt-xxxx directory): the terminal's cwd and editor links
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
  /** set when spawned as one of N parallel attempts at the same prompt */
  variant?: { group: string; index: number; of: number };
  /** open PR created from this worktree (via gh) */
  prUrl?: string;
  /** where this worktree came from when it was opened onto something that already existed: a
   * local branch, a remote one, or a PR pulled in to review. The opposite direction from `prUrl`,
   * which is a PR made from the worktree. Absent on a task toyon started from a prompt. */
  from?: { kind: "branch" | "remote" | "pr"; ref: string; pr?: { number: number; url: string; title: string } };
  /** the shell tab that asked for it (client nonce); that tab focuses it, others don't */
  createdBy?: string;
  /** registry id of the agent working here (stamped at creation, or on first use for older rows) */
  agent?: string;
  /** which of the repo's profiles this worktree runs (the repo's defaultProfile when absent) */
  profile?: string;
  /** what the agent may do here without asking; DEFAULT_PERMISSION_MODE when absent */
  mode?: PermissionMode;
  /** the model id the agent is asked to run here (one of its advertised choices); its own default
   * when absent. What actually ran is the session-info event in the transcript. */
  model?: string;
  /** the effort level the agent is asked to run at here (one of its advertised choices, which
   * depend on the model); its own default when absent */
  effort?: string;
  /** when the agent last finished a turn here. Absent until one has run. */
  lastTurnAt?: number;
  /** when the person last sent something here, a chat message or a `!` command. The rail sorts on
   * it, so a row rises because someone worked in it and never because its agent did. Absent on a
   * row nothing has been sent to since the field landed. */
  promptedAt?: number;
  /** when someone last looked at this worktree in a shell. Absent until it has been looked at
   * since the feature landed, which reads as "seen" so old rows do not all light up at once. */
  seenAt?: number;
  /** the person marked it unread to come back to; rings the row until it is next seen */
  unread?: boolean;
  /** main only: nothing tracked and nothing untracked, which is what a project made from the
   * picker looks like until something is scaffolded into it. Kept current by every git status
   * read, and stored so the first frame of a page load can say so without asking git. */
  empty?: boolean;
}

/** the branch is toyon's to manage: made by create or a spare claim, so removing the
 * worktree may delete it and a title link may be planted beside it. An adopted worktree runs on
 * a branch the person made, in a directory they chose, and neither is toyon's to touch. */
export function hasOwnBranch(wt: Pick<WorktreeInfo, "branch">): boolean {
  return wt.branch.startsWith("toyon/");
}

/** `unreachable`: alive, but nothing answered on its port before the deadline and it bound no
 * other port either (a server that never listens, or listens somewhere toyon cannot see) */
export type ProcStatus = "starting" | "running" | "unreachable" | "crashed" | "stopped";

export interface ProcState {
  name: string;
  command: string;
  /** the port toyon assigned, handed to the proc as $PORT */
  port: number;
  status: ProcStatus;
  pid?: number;
  exitCode?: number | null;
  /** address family the proc actually listens on (some dev servers bind ::1 only) */
  host?: string;
  /** the port it really bound when it ignored $PORT; the proxy and the sibling URLs follow this */
  boundPort?: number;
  /** why it is unreachable, or what it is doing on the wrong port, for the person at the shell */
  detail?: string;
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

/** "waiting" means blocked on a person (an open ask card), not on the model */
export type AgentStatus = "idle" | "working" | "waiting" | "error";

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
  /** the word its models' rows start with in a list that spans agents ("Claude"); `name` when absent */
  short?: string;
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
  /** the models it advertised the last time a session opened; absent until one has */
  models?: ModelChoice[];
  /** the effort levels it advertised the last time a session opened on a model that has them */
  efforts?: ModelChoice[];
}

/** what settings shows about an agent's own setup: the files it reads and the MCP servers it will
 * load, as found on disk. Read-only: the files are the person's, edited where they were made. */
export interface AgentConfigInfo {
  agent: string;
  files: AgentConfigFile[];
  servers: McpServerInfo[];
}
export interface AgentConfigFile {
  /** stable within the agent, for reveal requests */
  id: string;
  label: string;
  path: string;
  exists: boolean;
}
export interface McpServerInfo {
  name: string;
  /** where it is declared: the person's own config, the repo's file, or the config's entry for
   * this repo's path */
  scope: "user" | "project" | "local";
  /** the command line or the URL, for telling two apart */
  detail: string;
}

/** one choice of an agent's select config option (a model, an effort level), as ACP lists them */
export interface ModelChoice {
  id: string;
  name: string;
  description?: string;
}

/** The choice an agent marks as its own default, if it lists one. ACP does not flag it, so this
 * is the id the adapters that have one use (Claude's model and effort selects both lead with a
 * `default` entry). Setting it is a real request the agent honours, unlike the empty option,
 * which sends nothing and leaves the agent where it is. */
export function agentDefault(choices: ModelChoice[]): ModelChoice | undefined {
  return choices.find((c) => c.id === "default");
}

/** The row the agent's default only names. Claude's model select leads with "Default
 * (recommended)", described as "Opus (1M context)", which is the next row's name: two rows for
 * one model. The picker draws the named row in place of both. Nothing when the description names
 * no row (Claude's effort default carries none), and the default row stays. */
export function defaultStandsFor(choices: ModelChoice[]): ModelChoice | undefined {
  const own = agentDefault(choices);
  if (!own?.description) return undefined;
  return choices.find((c) => c !== own && c.name === own.description);
}

/** The pre-warmed worktree a repo's next task will claim. Never a rail row: nobody works in it,
 * and the rail's ⌘1-9 must not count it. Its preview is what a draft tab shows while the prompt
 * is still being typed, since it is the code the task starts from; on claim the same id becomes
 * the task's row. */
export interface SpareInfo {
  repoId: string;
  id: string;
  proxyPort: number;
  /** its procs and proxy are up, so the port answers (with the waiting page until the preview
   * proc does) */
  ready: boolean;
}

/** A worktree that was removed. Removing archives: the directory and branch go, while the chat,
 * its attachments and a git ref to the commits and uncommitted work stay with the daemon until the
 * worktree is restored or deleted for good. */
export interface ArchivedWorktree {
  id: string;
  repoId: string;
  title: string;
  branch: string;
  createdAt: number;
  archivedAt: number;
  /** the first message sent, so a row can say what the work was */
  prompt?: string;
  /** git still holds its commits, so a restore brings the work back and not only the chat */
  restorable: boolean;
  /** uncommitted changes were kept beside the commits */
  uncommitted?: boolean;
  /** it had been merged into main */
  landed?: boolean;
}

/** One row of the rail: a worktree toyon runs, or one git knows about that toyon did not create
 * (made in a terminal, by another agent, by an editor). Ownership is `worktree`. Present, and
 * toyon has a record, a port, procs and an agent for it, and may write to it. Absent, and the
 * row is derived from `git worktree list` on every push and never persisted: readable through
 * its id (status, history, diffs, a shell), never written to, and gone from the list the moment
 * git stops listing it. One type rather than two so take-over is a change of one field and every
 * frame lists every row at once; two frames once let the rail show a taken-over row twice. */
export interface WorktreeStatus {
  /** the record's id, or for a found worktree its canonical path hashed: derived rather than
   * stored, so the terminal, the changes panel and every per-worktree message keep their key
   * across pushes, and an open shell is not dropped by a re-derivation */
  id: string;
  repoId: string;
  path: string;
  /** the title, or for a found worktree its branch, or its directory's name when detached */
  name: string;
  /** absent when the worktree is detached */
  branch?: string;
  /** another tool holds it (a live agent session, usually): nothing may write to it, and
   * take-over is refused */
  locked?: boolean;
  /** git's reason for the lock, when it gave one */
  lockReason?: string;
  /** the record, when toyon owns the row */
  worktree?: WorktreeInfo;
  /** empty for a row toyon does not run */
  procs: ProcState[];
  /** "idle" for a row toyon does not run */
  agent: AgentStatus;
  /** commits ahead/behind the default branch (cached, ~10s freshness); absent on a detached
   * worktree, which has nothing to count against. On main, `behind` counts against its upstream
   * as of the last fetch (the daemon fetches now and then while main is on screen), and `ahead`
   * is absent: what main trails is origin, and what it leads is nobody's business here. */
  ahead?: number;
  behind?: number;
  /** uncommitted file count (cached, ~10s freshness) */
  dirty?: number;
  /** chat messages waiting behind the current turn */
  queued?: number;
  /** the agent's last reported figures here: context in use of the window, and the session's
   * spend when the agent prices itself. From the transcript, so a cold worktree has them too. */
  usage?: { used: number; size: number; cost?: number };
  /** a turn finished here since the last time anyone looked at it. The rail rings the dot: green
   * alone cannot separate "just finished" from "untouched for a week". */
  unseen?: boolean;
}

/** a row toyon owns, which is the one most of the shell reads: the chat, the composer, landing */
export type OwnedWorktree = WorktreeStatus & { worktree: WorktreeInfo };

export type RefKind = "branch" | "remote" | "pr";

/** Something the ref palette can open as a worktree: a local branch nobody has checked out, a
 * remote branch as of the last fetch, or an open pull request. Never a rail row: the rail lists
 * directories, and a ref becomes one only when someone opens it. */
export interface RefHit {
  kind: RefKind;
  /** what open-ref takes back: the branch name, the remote branch without its remote, or the PR
   * number as a string */
  ref: string;
  /** what the row prints: the branch, `origin/branch`, or `#n title` */
  name: string;
  /** the tip's subject, for a branch */
  subject?: string;
  /** when it last moved, ms since the epoch */
  at?: number;
  /** already merged into the default branch; listed only when searched for by name */
  merged?: boolean;
  pr?: { number: number; url: string; title: string; author: string; draft?: boolean; head: string; fork?: boolean };
  /** the row that already has it checked out: picking this switches there instead of opening
   * a second worktree on the same branch, which git would refuse anyway */
  openIn?: string;
}

export interface GitFileStatus {
  path: string;
  /** two-char porcelain XY code, e.g. "M ", " M", "A ", "??" */
  xy: string;
  /** lines added / deleted; absent for binary files and untracked directories */
  add?: number;
  del?: number;
}

/** one commit in the history list: enough to draw a row, not to diff it */
export interface CommitEntry {
  sha: string;
  /** abbreviated sha, however git chose to abbreviate it for this repo */
  short: string;
  subject: string;
  author: string;
  /** author date, epoch ms */
  at: number;
  /** ahead of the default branch: this worktree's own work, not history it inherited */
  ahead: boolean;
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
  /** The authored palette, in families: surfaces, interaction states, lines and text are four
   * different questions, and the numbering only orders within one. The seven hues are the
   * interchange format every colour scheme since ANSI has shipped. Only the accent, the scrim and
   * the shadow are derived, in themeToCssVars, because those are the three a theme was never
   * really deciding. */
  colors: {
    /** surfaces: the canvas, the chrome that sits on it, and things raised above both */
    surface0: ThemeColor;
    surface1: ThemeColor;
    surface2: ThemeColor;
    /** interaction states: under the pointer, and picked */
    element0: ThemeColor;
    element1: ThemeColor;
    /** lines: the everyday rule, and one that has to hold an edge on its own */
    border0: ThemeColor;
    border1: ThemeColor;
    /** text: what you read, what you scan, what you skip */
    text0: ThemeColor;
    text1: ThemeColor;
    text2: ThemeColor;
    red: ThemeColor;
    orange: ThemeColor;
    yellow: ThemeColor;
    green: ThemeColor;
    aqua: ThemeColor;
    blue: ThemeColor;
    purple: ThemeColor;
    /** diff line tints (alpha hex); a real one cannot be computed from a syntax colour */
    diffAdd: ThemeColor;
    diffDel: ThemeColor;
  };
  /** editor token colors; missing entries inherit Monaco's base theme */
  syntax?: Partial<Record<ThemeSyntaxToken, ThemeColor>>;
  /** which palette color carries "you are on this one": the active worktree, an `on` tab, a
   * checked box. Gruvbox and the rest select in orange; Toyon selects in its berry. Defaults to
   * orange, which is what an imported VS Code theme gets. */
  accent?: ThemeColorKey;
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

// ---- Design system ----

/** What a token's value is for, decided from the value itself rather than its name: a project can
 * call a color anything, but `#6fae5f` is only ever a color. */
export type DesignTokenKind = "color" | "length" | "font" | "shadow" | "other";

/** one CSS custom property. `value` is what the running page resolved it to when the preview was
 * up, and what the stylesheet declared when it was not. */
export interface DesignToken {
  name: string;
  /** as the stylesheet writes it, which is what you would go and edit */
  value: string;
  /** what a `var()` reference points at, followed through the project's own declarations. Absent
   * when the value is already literal, or when only the cascade could work it out. */
  resolved?: string;
  /** the name's first segment (`surface` for `--surface0`); what groups the swatch rows */
  family: string;
  kind: DesignTokenKind;
}

/** What a written-out value is doing, read off the property it sits on: `13px` is type on a
 * `font-size` and a radius on a `border-radius`, and the value alone cannot say which. */
export type DesignLiteralRole = "color" | "family" | "size" | "radius" | "shadow";

/**
 * A value a stylesheet writes out where it is used instead of naming it. A project with no custom
 * properties still has a palette and a type scale; they are spelled in place, rule by rule, and
 * these are what the pane shows when there are no tokens to show.
 */
export interface DesignLiteral {
  /** the first spelling seen, which is what a search of the source will find */
  value: string;
  role: DesignLiteralRole;
  /** declarations that write it */
  uses: number;
  /** the rules that write it, the first few, in stylesheet order */
  selectors: string[];
  /** the stylesheet that writes it first */
  path: string;
  /** a size's face and leading: its own rule's, else whatever the page root sets. A size alone
   * would render in the pane's face, which is not the one the project reads it in. */
  family?: string;
  lead?: string;
  /** set as a background on html, body or :root: the page's own ground, and so what contrast is
   * measured against */
  ground?: boolean;
}

/** a string-literal union prop: the values a component says it allows */
export interface DesignVariant {
  prop: string;
  values: string[];
  /** values never seen rendering. Empty until a live harvest has run. */
  unused: string[];
}

/** a component found in source, with how much of the project actually reaches for it */
export interface DesignComponent {
  name: string;
  /** worktree-relative */
  path: string;
  /** how many other files import it */
  imports: number;
  variants: DesignVariant[];
}

/** a class the project's own stylesheets define, with how often source names it */
export interface DesignClass {
  name: string;
  uses: number;
  /** the stylesheet that defines it, when the scan could attribute it */
  path?: string;
  /** seen as the only class on an element at least once. False means it only ever rides with
   * another (`btn btn-outline`, `row on`), which makes it a modifier rather than a thing. */
  solo: boolean;
  /** how many separate source files apply it. One means it is that file's own styling, however
   * many times it appears there. */
  files: number;
  /** used across several files, standing on its own, and no component is named for it. Whatever
   * this class styles, the markup around it is restated at every call site. */
  unwrapped: boolean;
}

/**
 * What the scan actually recognised. An empty section has two very different causes: the project
 * does not have that thing, or the scan does not read that dialect (CSS Modules, Sass variables, a
 * template language it never opened). Without this the pane cannot tell them apart, and reports
 * "no classes" about a project full of them.
 */
export interface DesignCoverage {
  /** how many files were read, by extension */
  files: Record<string, number>;
  stylesheets: number;
  customProps: number;
  /** class attributes seen across every source file; zero alongside a full tree means the markup
   * is somewhere this scan does not look */
  classAttrs: number;
}

/** Everything the design pane renders, and what the agent queries before it invents a color.
 * Merged from a static repo scan and a harvest off the running page; the flags and the
 * coverage record say which halves are present, so the pane can name what is missing rather than
 * render a gap as an answer. */
export interface DesignIndex {
  scannedAt: number;
  /** the preview was running and answered the harvest: tokens are resolved, drift is real */
  live: boolean;
  /** the project shipped a typescript the daemon could parse prop unions with */
  typed: boolean;
  tokens: DesignToken[];
  /** colours and sizes the stylesheets write out rather than name */
  literals: DesignLiteral[];
  components: DesignComponent[];
  classes: DesignClass[];
  coverage: DesignCoverage;
}
