// Domain records shared by daemon, shell and CLI: repos, worktrees, processes, git status, themes.

/** one way to run a repo: which of its procs, with what extra environment */
export interface RunProfile {
  /** keys of ToyonConfig.run, started in this order */
  run: string[];
  /** merged into every proc of the profile; `$API_URL` / `${API_URL}` expand to the sibling-URL
   * variables the daemon computes for the procs already up (unknown refs are left as written) */
  env?: Record<string, string>;
  /** preview proc for this profile; must be one of `procs` */
  preview?: string;
}

/** how a repo lands work on main; every field has a default, see land.ts */
export interface LandConfig {
  /** where landed work ends up: merged into main here (the default), merged here and pushed, or
   * pushed as a branch with a pull request opened */
  route?: "merge" | "push" | "pr";
  /** pr only: GitHub merges the PR itself once its rules (checks, reviewers) allow */
  automerge?: boolean;
  /** how the commits arrive on main: a merge commit (the local default), one squashed commit, or
   * the commits as they are. Unset on the PR route follows what the repo allows, squash first */
  method?: "merge" | "squash" | "rebase";
}

/** a repo's settings file (see config.ts for where it lives), shared and local merged */
export interface ToyonConfig {
  /** the JSON schema an editor validates the file against; toyon itself ignores it */
  $schema?: string;
  /** shell commands run once when a worktree is created */
  setup?: string[];
  /** what keeps running: name -> foreground shell command, each a process with its own terminal
   * tab; one serving HTTP must listen on $PORT */
  run: Record<string, string>;
  /** a command that must exit 0 before a worktree is offered to land: run in the worktree after
   * every finished turn, its output on the transcript */
  check?: string;
  /** shell commands run in the main checkout, in order, once work has landed on the default
   * branch: the build, the migration, the install a person would otherwise remember to do by
   * hand. Nothing waits on them, and a failure stops the rest. */
  afterLand?: string[];
  land?: LandConfig;
  /** proc that the preview iframe should show (defaults to "web", else first proc) */
  preview?: string;
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
  /** the settings file a save writes, relative to the root: the one already there, else where a
   * new one goes. What the setup pane and the agent's prompts name. */
  configFile: string;
  /** config was auto-detected and not yet confirmed by the user */
  needsSetup: boolean;
  /** the file the unconfirmed guess was read from, relative to the root (package.json, start.sh):
   * the setup pane opens it so the person can copy the script they meant. Gone once confirmed. */
  guess?: string;
  /** detection found a build file that says there is nothing to preview (Cargo.toml, go.mod) and
   * nothing that serves a page: the project opens on the chat rather than the setup pane. Only with
   * `needsSetup`, never written anywhere, and gone once setup is saved. */
  assumed?: string;
  /** toyon made this project from nothing: the whole folder, or only the `.git` in an empty folder
   * the person already had. What going back from the first-run screen may take away again, and
   * only while the project is still exactly as it was made. Absent on a repo that was opened. */
  made?: "folder" | "git";
  /** an `origin` remote exists, read at register and boot: what decides whether a PR is offered */
  remote?: boolean;
}

/** Toyon running out of a checkout that is also one of its own projects: what landing work on
 * that project's default branch has left behind. Null for the npm package, which has no tree to
 * fall behind, and for a checkout nobody opened as a project.
 *
 * Two halves fall behind separately. The shell and the bridge are read off disk on every request,
 * so a rebuild is enough and nothing has to stop; the daemon's own code is in memory from the
 * moment it booted, so only a restart picks it up. Work that touched `shared` is both. */
export interface SelfState {
  /** the project whose default branch moved: the checkout the daemon is running from */
  repoId: string;
  /** the bundles on disk are behind the branch; the repo's `afterLand` is what catches them up */
  rebuild: boolean;
  /** the running process is behind the branch */
  restart: boolean;
  /** `afterLand` is running right now */
  building: boolean;
  /** why the last `afterLand` stopped, when it did not finish cleanly */
  buildFailed?: string;
}

/** How this Toyon was installed, which decides whether it can install its own update: a global npm
 * or bun install can, an npx copy can only say how, and a source tree or a deployed image never
 * looks. */
export type InstallMethod = "npm" | "bun" | "npx" | "none";

/** Toyon's own version against what is installed and what is out, and an update under way. An
 * install replaces the package's files under a daemon that keeps running the code it started with,
 * so running and installed can differ until it restarts. */
export interface UpdateState {
  /** the version this daemon started as */
  running: string;
  /** the newest version the registry has, when it is newer than the one running */
  latest: string | null;
  /** the version on disk, when it is not the one running */
  installed: string | null;
  method: InstallMethod;
  /** an install is running */
  installing: boolean;
  /** the last install stopped: the version, the last line it printed, and the command to run by hand */
  failed: { version: string; line: string; command: string } | null;
  /** a restart was asked for and waits on these chats to finish replying; empty once it is under
   * way, null when nobody asked */
  restarting: string[] | null;
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

/** a folder picked in the OS dialog, and what it is, which decides what the new-project form does
 * with it: an ordinary folder is where the project goes, an empty one can become the project, and
 * one that is already a project is opened rather than nested into */
export interface ChosenFolder {
  /** absolute, tilde-collapsed like PathEntry.path */
  path: string;
  kind: "folder" | "empty" | "project";
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
  /** set when it failed. The record stays so the reason is still there to read, since a passing line
   * would be gone before someone who walked away from a long clone came back to it. */
  error?: string;
}

export type WorktreeKind = "main" | "worktree" | "spare";

/** how far along the repo's spare is: its record and row exist from `reserved`; `warming` is deps,
 * setup and servers under way; `ready` is a warm copy waiting to be typed into. Persisted, so a
 * daemon that restarts picks a half-made spare up where it was. */
export type SparePhase = "reserved" | "warming" | "ready";

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

/** One landing: the commits `base..tip`, where `tip` is the branch as it landed and `base` is where
 * it sat on the default branch. */
export interface LandMark {
  base: string;
  tip: string;
  at: number;
}

export interface WorktreeInfo {
  id: string;
  repoId: string;
  /** the checkout: `<worktrees>/<repo>/wt-xxxx` for one toyon made, the directory the person chose
   * for one it adopted. A rename never moves it (the procs and the agent's cwd would restart), so
   * the branch is what carries the name. */
  path: string;
  /** `toyon/<slug>` for a worktree toyon made (its directory's `wt-xxxx` at birth, the title's slug
   * once it is named or renamed), the person's own branch for one it adopted. The slug keeps up
   * with the title without ever being it. */
  branch: string;
  kind: WorktreeKind;
  /** a spare's progress toward warm; absent on every other kind, and gone the moment it is claimed */
  phase?: SparePhase;
  /** the lockfile a ready spare's deps were copied under, so a main that moved re-runs setup only
   * when the deps changed; spare only, like `phase` */
  lockfile?: string;
  /** port of this worktree's reverse proxy (preview iframe target) */
  proxyPort: number;
  /** what the rail calls it, in words a person would say: spaces and capitals and all. Nothing is
   * spelled from this; the branch takes its slug. */
  title: string;
  /** the title is the prompt's first words, standing in until the agent or the person names it:
   * the rail shows it a tier down so its changing is no surprise, and one never named stays that
   * way as the cue to rename it */
  unnamed?: true;
  createdAt: number;
  /** merged into main and no new work since */
  landed?: boolean;
  /** every landing, oldest first, each tip kept under a ref: the branch restarts from main after
   * one, so these are what still names the commits it carried */
  lands?: LandMark[];
  /** set when spawned as one of N parallel attempts at the same prompt */
  variant?: { group: string; index: number; of: number };
  /** the pull request this worktree opened, and what GitHub last said about it; absent until the
   * PR route has run here. Gone with new work after it merged. */
  pr?: PrState;
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
  /** how the agent last stopped here, and what the turns since someone looked did. Absent until a
   * turn has run. The rail's ring and the recap both read it. */
  lastTurn?: LastTurn;
  /** whether the work here is ready to land, and the message it would land with. Written after a
   * finished turn once the check has run; gone when the tree changes or a new turn starts. */
  landing?: Landing;
  /** when the person last sent something here, a chat message or a `!` command. The rail sorts on
   * it, so a row rises because someone worked in it and never because its agent did. Absent on a
   * row nothing has been sent to since the field landed. */
  promptedAt?: number;
  /** when someone last looked at this worktree in a shell. Absent until it has been looked at
   * since the feature landed, which reads as "seen" so old rows do not all light up at once. */
  seenAt?: number;
  /** when a tab last showed this worktree. Different from `seenAt`, which is about the unseen
   * ring and waits for focus: this one is what decides which dev servers a restarted daemon
   * brings back, and whether a finished turn is worth booting one for. */
  viewedAt?: number;
  /** the person marked it unread to come back to; rings the row until it is next seen */
  unread?: boolean;
  /** its agent showed a plan here, approved or not: a plan is worth keeping, so the row never
   * archives itself. Stamped when the card is shown, since a transcript cannot tell one apart. */
  planned?: boolean;
  /** the latest plan its agent wrote, relative to the worktree: the composer keeps a way to it
   * from the moment the card shows until the next plan replaces it, since the card and the row
   * that reads it back scroll away while the work goes on. Unset for a plan no file could be
   * written for. */
  plan?: string;
  /** main only: nothing tracked and nothing untracked, which is what a project made from the
   * picker looks like until something is scaffolded into it. Kept current by every git status
   * read, and stored so the first frame of a page load can say so without asking git. */
  empty?: boolean;
}

/** A worktree's pull request as GitHub last described it, read through `gh` after it opens, on
 * focus, and every few minutes while it is open. The composer's line and its verbs read this. */
export interface PrState {
  number: number;
  url: string;
  state: "open" | "merged" | "closed";
  /** GitHub's review decision; absent when the repo requires no review */
  review?: "approved" | "changes_requested" | "review_required";
  /** the checks, folded to one word; absent when the PR has none */
  checks?: "pending" | "pass" | "fail";
  /** GitHub says the merge button would work now */
  mergeable?: boolean;
  /** auto-merge is on: GitHub merges it once its rules allow */
  automerge?: boolean;
  /** when GitHub was last asked */
  at: number;
}

/** how an agent stopped: it finished, someone stopped it, it failed, or it is blocked asking you */
export type TurnEnd = "done" | "stopped" | "failed" | "asking";

/** what the turns since someone last looked did, read off the transcript when the agent stopped.
 * A lower bound once the transcript has been compacted past them. */
export interface TurnFacts {
  /** turns in the window, at least one */
  turns: number;
  /** file writes: edit, delete and move calls. Shell commands are not counted. */
  edits: number;
  /** tool calls that came back as errors */
  toolErrors: number;
  /** why it failed, when it did */
  error?: string;
  /** it failed for want of a login */
  auth?: true;
  /** a stop reason other than finishing or being stopped (max_tokens, refusal) */
  cut?: string;
  /** what it is asking, while it is blocked on you */
  ask?: string;
  /** it stopped because the plan was sent back: the agent ends its turn on that answer, the way
   * its own terminal does, and waits to hear what should change */
  planBack?: true;
}

export interface LastTurn {
  at: number;
  end: TurnEnd;
  facts: TurnFacts;
  /** the agent's one sentence on where the work stands, written a moment after a finished turn:
   * with the landing verdict when there is work on the tree, from the smaller answer question when
   * there is none. Absent on every other stop, and on an agent with no quick model, where the line
   * is the facts. */
  recap?: { at: number; text: string };
}

/** What the daemon knows about landing a worktree after a turn: whether the repo's check passed,
 * a commit message for the work, and the model's doubt about it if it had one. The composer
 * offers `land` while `ready`, which facts alone decide; the doubt is a sentence beside the word,
 * never a gate, since a wrong gate hides the feature and a wrong sentence costs a line. The
 * changes panel shows the message as its box's placeholder. */
export interface Landing {
  /** the turn end it describes */
  at: number;
  /** `pending` while the check runs and the message is written; `none`: the repo has no check
   * command, so the turn alone is the word */
  check: "pending" | "pass" | "fail" | "none";
  /** the last lines of a failed check, for the placeholder */
  checkTail?: string;
  /** the check passed, or there is none, and the verdict is in: the word can show */
  ready: boolean;
  /** the model's doubt, in one line, when the work did not read as finished to it */
  why?: string;
  /** the suggested commit message: a subject, and a body when there was more to say */
  subject?: string;
  body?: string;
  /** HEAD plus the diff's shape when this was written: a tree that no longer matches marks it stale */
  fingerprint: string;
  /** the tree moved since this was written, by a hand or another tool: the message and the
   * sentence still describe the work, the check does not, so the word waits on it running again */
  stale?: true;
}

/** the branch is toyon's to manage: made by create or a spare claim, so removing the
 * worktree may delete it and a title link may be planted beside it. An adopted worktree runs on
 * a branch the person made, in a directory they chose, and neither is toyon's to touch. */
/** the other attempts in a variant's group, itself left out; none for a worktree that is not one */
export function siblingsOf(wt: Pick<WorktreeInfo, "id" | "variant">, rows: readonly WorktreeInfo[]): WorktreeInfo[] {
  if (!wt.variant) return [];
  const group = wt.variant.group;
  return rows.filter((w) => w.id !== wt.id && w.variant?.group === group);
}

export function hasOwnBranch(wt: Pick<WorktreeInfo, "branch">): boolean {
  return wt.branch.startsWith("toyon/");
}

/** it stopped since anyone last looked, or someone marked it to come back to. A worktree with no
 * record reads as seen. */
export function isUnseen(wt: WorktreeInfo): boolean {
  return wt.unread === true || (wt.lastTurn != null && (wt.seenAt == null || wt.seenAt < wt.lastTurn.at));
}

/** `unreachable`: alive, but nothing answered on its port before the deadline and it bound no
 * other port either (a server that never listens, or listens somewhere toyon cannot see).
 * `asleep`: stopped by toyon because nobody had looked at the worktree for a while; it keeps its
 * port and comes back on the same one the next time something needs it. */
export type ProcStatus = "starting" | "running" | "unreachable" | "crashed" | "stopped" | "asleep";

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
  /** why it is unreachable, what it is doing on the wrong port, or why toyon put it to sleep
   * ("nobody looked for 2 h", "short of memory"), for the person at the shell */
  detail?: string;
}

/** the worktree's own shell, as a stream name. Every other stream is a proc, named by its key in
 * toyon.json, which is why that key cannot be this. */
export const SHELL_STREAM = "shell";

/** the agent's terminal login, as a stream name: a tab of its own while the login runs, and after
 * it fails, so a proc cannot be named this either */
export const LOGIN_STREAM = "login";

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
  /** fetched only when someone asks for it (a large download), so "not installed" is its resting state */
  onDemand?: boolean;
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

/** The state of a repo's default branch checkout, which the plus's row wears and the composer's
 * line under the knobs reads: how far it trails origin, what is uncommitted there, and whether an
 * automatic fast-forward was held back. Never a rail row while the repo has a spare: the spare is
 * main's running copy, and this is what main itself says. `id` is the checkout's own record, the
 * target of `pull-main`, of a carry, and of the setup pane's log. */
export interface TrunkStatus {
  id: string;
  /** commits behind the upstream as of the last fetch; absent with no upstream */
  behind?: number;
  /** uncommitted files in the checkout */
  dirty: number;
  /** nothing tracked and nothing untracked: a project made from the picker before anything landed */
  empty: boolean;
  /** why the checkout was not fast-forwarded when origin moved: uncommitted files sit on it, its
   * history diverged from origin's, or it has no upstream to follow */
  stale?: "dirty" | "diverged" | "no-upstream";
}

/** A worktree that was removed. Removing archives: the directory and branch go, while the chat,
 * its attachments and a git ref to the commits and uncommitted work stay with the daemon until the
 * worktree is restored or deleted for good. */
export interface ArchivedWorktree {
  id: string;
  repoId: string;
  title: string;
  branch: string;
  /** the directory it had, so the paths in its chat still read relative to it */
  path: string;
  createdAt: number;
  archivedAt: number;
  /** the first message sent, so a row can say what the work was */
  prompt?: string;
  /** git still holds its commits, so a restore brings the work back and not only the chat */
  restorable: boolean;
  /** uncommitted changes were kept beside the commits */
  uncommitted?: boolean;
  /** how many files those changes touched, counted as the worktree was removed; absent when git
   * could not say */
  dirty?: number;
  /** it had been merged into main */
  landed?: boolean;
  /** what its agent's session cost, as the agent last reported it; only an agent that prices
   * itself reports one, so a chat run by one that does not has no figure */
  cost?: number;
  /** why it archived itself, as the rail says it; absent when someone archived it */
  auto?: string;
  /** its chat's transcript on disk, where the archive keeps it now: what another tool is pointed
   * at to read this chat */
  transcript: string;
  /** the agent's own session id, when it opened one: what its CLI resumes outside toyon */
  sessionId?: string;
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
  /** the agent's terminal login is running here, or failed and still shows why: the login tab */
  login: boolean;
  /** commits ahead/behind the default branch (cached, ~10s freshness); absent on a detached
   * worktree, which has nothing to count against. On main, `behind` counts against its upstream
   * as of the last fetch (the daemon fetches now and then while main is on screen), and `ahead`
   * is absent: what main trails is origin, and what it leads is nobody's business here. */
  ahead?: number;
  behind?: number;
  /** commits here that the branch on origin does not have, counted only while a PR is open: the
   * work the PR is missing, which `update` pushes. Absent otherwise. */
  unpushed?: number;
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
  /** the chat's transcript on disk: what another tool is pointed at to read this chat. Absent on
   * a found worktree, which has no chat. */
  transcript?: string;
  /** the agent's own session id here, once it has opened one: what its CLI resumes outside toyon */
  sessionId?: string;
}

/** a row toyon owns, which is the one most of the shell reads: the chat, the composer, landing */
export type OwnedWorktree = WorktreeStatus & { worktree: WorktreeInfo };

export type RefKind = "branch" | "remote" | "pr";

/** Something the ref palette can open as a worktree: a local branch nobody has checked out, a
 * remote branch as of the last fetch, or an open pull request. Never a rail row: the rail lists
 * directories, and a ref becomes one only when someone opens it. */
/** One place a project's chats say what was searched for: something the person sent or the model
 * wrote back, never a tool's output. A chat is found by its worktree, live or archived, and the row
 * inside it by `seq`, which is the transcript entry the row starts at. */
export interface ChatHit {
  worktreeId: string;
  /** the worktree was removed: its page reads the chat where it was kept */
  archived: boolean;
  /** a message's own seq, or the first seq of the run of prose it sits in */
  seq: number;
  role: "user" | "assistant";
  /** the text around the first match, whitespace collapsed, with an ellipsis where it was cut */
  text: string;
  /** where the match sits in `text`: its start and its length */
  match: [number, number];
  /** when it was said: the message's stamp, or the start of the turn the prose is in; 0 unknown */
  ts: number;
}

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
  /** when the landing that carried it happened; only an archived worktree's history says, since
   * there the commits are all its own and the landings are what divide them */
  landedAt?: number;
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

/** What the two following modes follow, each as "is it dark there now": the OS's appearance, and
 * the sun where the shell is. The shell reads `system` off prefers-color-scheme; `daylight` is what
 * the daemon last worked out for the browser's own timezone, which is why it is not a media query. */
export interface DarkNow {
  system: boolean;
  daylight: boolean;
}

export interface ThemePrefs {
  /** appearance: paint the `dark` or `light` slot, follow prefers-color-scheme, or follow the sun
   * where the shell is. The last exists because a machine pinned to dark leaves `system` with
   * nothing to follow, and macOS only runs its own solar schedule while its appearance is Auto. */
  mode: "dark" | "light" | "system" | "daylight";
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
