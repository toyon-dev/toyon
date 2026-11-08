// Domain records shared by daemon, shell and CLI: repos, worktrees, processes, git status, themes.

import type { AttachmentRef } from "./protocol/events.ts";

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

/** A proc in the long form. A proc that is not the preview is the shared tier's by default when
 * Toyon can place its files in the tree (`paths` written, or a folder the command names): the main
 * checkout runs it once, on its working tree, and every worktree reaches that one through a
 * forwarder until its own changed files match `paths`, when it starts its own. */
export interface RunProc {
  cmd: string;
  /** "trunk": main runs it for every copy; with no folder to watch, no change flips it (a database
   * container whose databases are per copy). "copy": every copy runs its own. Absent: shared when
   * `paths` is declared or the command names a folder of the tree. */
  from?: "trunk" | "copy";
  /** globs from the root that make a copy run its own, for a command whose files inference cannot
   * place; never empty, and absent infers them from the command */
  paths?: string[];
  /** shell commands run once in a copy before this proc first runs there; never on main */
  setup?: string[];
  /** shell commands run in a copy that ran this proc's setup, when the copy goes */
  teardown?: string[];
  /** addresses a copy's page may point this proc at instead of main's or its own: name to URL */
  remotes?: Record<string, string>;
}
export type RunEntry = string | RunProc;

/** one proc of the shared tier, as the settings and the tree decide it: the globs that flip a
 * copy to its own, written or read off the command; none means no change flips it */
export interface TierProc {
  paths: string[];
}

/** why a copy runs a shared proc itself: its changes touched it (the file that did), the agent
 * asked ahead of an edit, or a person pressed for it */
export interface Owned {
  by: "edit" | "agent" | "hand";
  file?: string;
}

/** one proc as it stands for one copy: where its page reaches it when not main's, and whether the
 * proc's own setup ran here */
export interface ProcSource {
  /** the copy runs it itself, with why (its changes touched it, the agent asked, a person pressed),
   * or its page points at one of the proc's `remotes`. Absent: main's for a shared proc. Never
   * shrinking on its own; a pick of a remote wins over the flip. */
  at?: Owned | { remote: string };
  /** the proc's own `setup` ran here: its `teardown` runs when the worktree goes, a spare's refresh
   * runs the setup again, and a re-own skips it */
  prepared?: true;
}

/** a shared proc a copy reaches on main, with main's state of it; "cold" while main has not
 * started its tier */
export interface Borrowed {
  name: string;
  status: ProcStatus | "cold";
  detail?: string;
}

/** what the worktrees of a repo would share unless the settings keep them apart */
export interface SharedServices {
  /** a compose file at the root, by name */
  compose?: string;
  /** a database URL in an env file: the variable, and the file it was read from */
  envUrl?: { name: string; file: string };
}

/** The ceilings on what toyon runs for a worktree, as durations ("30m", "90s", "1h"). A run
 * still going at its ceiling is killed, so a hook that waits on a prompt nobody can answer
 * cannot hold a press forever; a suite that takes twenty minutes needs a ceiling above that. */
export interface Timeouts {
  /** each `setup` command on its own */
  setup?: string;
  /** the `check` command */
  check?: string;
  /** a commit, hooks included: the pre-commit suite is what runs long here */
  commit?: string;
}

/** the ceiling every kind of run has when the settings name none: past this a command left
 * running is nearly always stuck, and the suites that legitimately run longer say so in `timeouts` */
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** the runs a worktree can have out that a person waits on and a ceiling guards */
export type RunKind = "setup" | "check" | "commit";

/** Where a run stands. `queued`: asked for, not started (the one before it is still being
 * stopped, or the agent it reports through is not up yet). `running`: under the daemon's watch.
 * `detached`: a daemon restarted under it and found it still alive; it goes on unwatched until it
 * ends or is stopped. `terminated`: killed, at the ceiling or by a press, and `why` says which. */
export type RunStatus = "queued" | "running" | "detached" | "terminated";

/** One run of setup, the check or a commit on a worktree: what the wait on it can say. One per
 * kind at a time; a new one of the same kind takes the old one's place. */
export interface RunState {
  kind: RunKind;
  status: RunStatus;
  /** when it was asked for; the elapsed time counts from here */
  since: number;
  /** the ceiling it runs under */
  timeoutMs: number;
  /** what it is on: the setup command and its place in the list, or the hook a commit is in.
   * What it prints is not here: the transcript row streams that, and a frame rebuilds every row
   * in every tab. */
  stage?: string;
  /** its process group, so a daemon that comes back under it can ask whether it is still there */
  pid?: number;
  /** why it ended, once terminated */
  why?: string;
}

/** What a copy builds that the next copy can start from: the folders and files named here are
 * kept after the repo's check passes and cloned into every new copy, keyed by the lockfiles, the
 * tool versions, the platform and the commit the copy was cut from (see cache.ts). */
export interface CacheConfig {
  /** paths under the root: `node_modules`, `.mypy_cache`, `.testmondata`. A SQLite file brings
   * its `-wal` and `-journal` along. */
  paths: string[];
  /** files under the root whose contents key the entries, beside the lockfiles toyon knows */
  key?: string[];
  /** commands whose output keys the entries: the versions the artifacts were built by. Absent,
   * they follow from the lockfiles present (`bun --version` for a bun.lock); `[]` asks none. */
  tools?: string[];
}

/** a repo's settings file (see config.ts for where it lives), shared and local merged */
export interface ToyonConfig {
  /** the JSON schema an editor validates the file against; toyon itself ignores it */
  $schema?: string;
  /** shell commands run once when a worktree is created */
  setup?: string[];
  /** shell commands run once when a worktree goes, before its directory does: the database or
   * compose project a setup step made for it alone is dropped here. A failure is logged and the
   * removal goes on; a restored worktree runs `setup` again. */
  teardown?: string[];
  /** what keeps running: name -> foreground shell command, each a process with its own terminal
   * tab; one serving HTTP must listen on $PORT. The object form carries a proc's paths, setup,
   * teardown and remotes, and says whether the trunk runs it for every worktree. */
  run: Record<string, RunEntry>;
  /** a command that must exit 0 before a worktree is offered to land: run in the worktree after
   * every finished turn, its output on the transcript */
  check?: string;
  /** shell commands run in the main checkout, in order, once work has landed on the default
   * branch: the build, the migration, the install a person would otherwise remember to do by
   * hand. Nothing waits on them, and a failure stops the rest. */
  afterLand?: string[];
  land?: LandConfig;
  /** how long each kind of run may take before it is killed; DEFAULT_TIMEOUT_MS each when unset */
  timeouts?: Timeouts;
  /** what a copy builds that the next one starts from, kept once the check passes; the list of
   * paths alone is the short form */
  cache?: string[] | CacheConfig;
  /** proc that the preview iframe should show (defaults to "web", else first proc) */
  preview?: string;
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
  /** a database or a compose stack the worktrees would share, seen in the tree at register and
   * on each detection: a compose file at the root, or a database URL in an env file. What the
   * setup pane warns about while the settings keep no copy apart. Never written anywhere. */
  services?: SharedServices;
  /** the shared tier by proc: what main runs for every worktree, with the globs that flip a copy
   * to its own. Settled from the settings and the tree at every config read and at boot, and
   * again when main moves; absent means nothing is shared. Never written anywhere. */
  tier?: Record<string, TierProc>;
  /** toyon made this project from nothing: the whole folder, or only the `.git` in a folder the
   * person already had. What going back from the first-run screen may take away again, and only
   * while the project is still exactly as it was made. Absent on a repo that was opened. */
  made?: "folder" | "git";
  /** an `origin` remote exists, read at register and boot: what decides whether a PR is offered */
  remote?: boolean;
  /** the ref this repo's worktrees are measured against, born from, synced onto and landed onto,
   * when it is not the default branch here: main's upstream (`origin/main`) on the routes where
   * work ends up on origin. Absent on the merge route, and with no upstream, which reads as the
   * default branch (`baseOf`), so a record from before the field needs nothing. */
  base?: string;
  /** the newest send among the rows that have left it, written as each one goes: the switcher
   * sorts projects by their newest send and reads the open rows for it, so a project whose rows
   * were all landed and archived would otherwise sink to the bottom the moment the work was
   * tidied away. A record from before the field takes it from the archive at boot. */
  promptedAt?: number;
  /** what a new worktree of it starts with, as picked in the composer: the permission mode. The
   * default where absent. The daemon's memory, so every create of the repo and every shell read
   * the same one. */
  picks?: RepoPicks;
}

/** the mode a new worktree of a repo starts with, where the create names none */
export interface RepoPicks {
  mode?: PermissionMode;
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

/** A Toyon started with npx offering to install itself globally: an npx copy never updates and
 * leaves no `toyon` command behind. Offered only where nothing global answers to `toyon` already
 * and updates are on, and gone for good once installed or turned down. `installed` stays until the
 * person dismisses it, so the press is answered where it was made. */
export type GlobalInstall =
  | { state: "offered" }
  | { state: "installing" }
  | { state: "installed" }
  /** npm's last line worth reading, and the command to run by hand */
  | { state: "failed"; line: string; command: string };

/** What the registry said to a check a person asked for. It answers the one who asked, whatever
 * it found, since a check that finds nothing changes no state and the press would land in silence. */
export interface UpdateCheck {
  /** the registry asked, as npm's config names it: a company mirror can lag the public one */
  registry: string;
  /** the newest version it lists; null when it has no toyon or did not answer */
  latest: string | null;
}

/** one entry offered by the project picker's path completion: a folder, or a file to open */
export interface PathEntry {
  /** absolute path, tilde-collapsed for display and for typing back in */
  path: string;
  name: string;
  /** a git repo, so it can be opened as a project; otherwise a folder to descend into */
  isRepo: boolean;
  /** a regular file: picking it opens the file, in its project or on its own */
  isFile: boolean;
}

/** what the picker's typed path *is*, as opposed to what is inside it. Without this the picker
 * cannot tell "no such folder" from "folder with nothing matching yet": both arrive as an empty
 * entry list, and only one of them is somewhere a project could be made. */
export interface PathTarget {
  /** the typed path itself exists */
  exists: boolean;
  isDir: boolean;
  isRepo: boolean;
  /** a regular file, which is opened rather than made into anything */
  isFile: boolean;
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
  /** the branch being checked out, when the URL was a page on one */
  branch?: string;
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
  /** the pull request this landing was: what says a merged PR has been taken, whatever the tree
   * looks like since */
  pr?: number;
  /** what landed, as the one-line subjects main received, oldest first: a merged PR's title, the
   * squash message's subject for a squash, the branch's own commits otherwise, at most
   * LAND_SUBJECTS_MAX of them. Empty when there is nothing to say: a landing that carried no
   * commits of its own, or one whose range git could no longer read. */
  subjects: string[];
}

/** a piece of a plan waiting for a sibling to land before its worktree is made; on the origin's
 * record so it survives a restart and leaves with the origin */
export interface QueuedPiece {
  proposalId: string;
  pieceId: string;
  title: string;
  /** the title was cut to the name shape, so the worktree is named from the plan when made */
  provisional?: true;
  /** the plan its worktree is born with */
  plan: string;
  /** the worktree it waits for, by id alone (its record has the branch and title, which move after
   * a provisional sibling is made), or a piece of the same list not yet made into one */
  after: { id: string } | { piece: string };
  /** another open project the worktree is made in */
  project?: { id: string; name: string };
  /** what the origin's chat attached, re-attached when the worktree is made */
  attachments: AttachmentRef[];
  /** what the person added when they approved */
  note?: string;
  /** the origin's own here pieces that wait for this one, by title: they go onto the origin's
   * `awaits` once this is made into a worktree, since until then there is nothing to name */
  heres?: string[];
  queuedAt: number;
}

/** how many subjects a landing keeps: enough to say what a branch of ordinary size carried; a
 * longer one is cut where it is read */
export const LAND_SUBJECTS_MAX = 8;

/** the model and effort a new worktree of an agent is asked to run, where the create names none */
export type AgentPicks = Partial<Pick<WorktreeInfo, "model" | "effort">>;

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
   * the rail shows it a tier down so its changing is no surprise. The agent is asked at birth and
   * again after each turn that settles on a live agent while this stands, so an ask lost to an
   * outage is not the last word; one never named stays this way as the cue to rename it */
  unnamed?: true;
  createdAt: number;
  /** merged into main and no new work since */
  landed?: boolean;
  /** every landing, oldest first, each tip kept under a ref: the branch restarts from main after
   * one, so these are what still names the commits it carried */
  lands?: LandMark[];
  /** pieces of a plan waiting for a sibling to land before their worktree is made */
  queued?: QueuedPiece[];
  /** the worktrees this one's own work waits for, named by the here pieces of its list; each is
   * told on this chat when it lands, and goes from here with that. `pieces` are those here
   * pieces by title, what the agent is started on; a wait without them still releases. By id
   * alone: a worktree born on a provisional title takes its title's branch a moment after it is
   * made, so a branch copied here would be the one it was born with. Its record has the live one. */
  awaits?: Array<{ id: string; pieces?: string[] }>;
  /** the pull request this worktree opened, and what GitHub last said about it; absent until the
   * PR route has run here. Gone with new work after it merged. */
  pr?: PrState;
  /** where this worktree came from when it was opened onto something that already existed: a
   * local branch, a remote one, or a PR pulled in to review. The opposite direction from `prUrl`,
   * which is a PR made from the worktree. Absent on a task toyon started from a prompt. */
  from?:
    | { kind: "branch" | "remote" | "pr"; ref: string; pr?: { number: number; url: string; title: string } }
    /** made from a piece of another worktree's work, in this project or another: `ref` is that
     * worktree's branch and `origin` the row it came from. Kept as history once the origin is
     * gone; while the origin is listed, this row shows on its rail too. `plan` is the origin's
     * file the piece came from, for the whole picture; `after` the worktree this one waited for
     * before it was made, by id, so a later landing of it can be said here. */
    | {
        kind: "worktree";
        ref: string;
        origin: { id: string; repoId: string };
        plan?: string;
        after?: { id: string };
      };
  /** the shell tab that asked for it (client nonce); that tab focuses it, others don't */
  createdBy?: string;
  /** registry id of the agent working here (stamped at creation, or on first use for older rows) */
  agent?: string;
  /** per proc, who this worktree's page talks to when not main's, and what the worktree holds of
   * it: see ProcSource. Absent for a proc main runs for it (shared) or that every copy runs (not). */
  sources?: Record<string, ProcSource>;
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
   * finished turn once the check has run. One that says the work can land stands through a new
   * turn while the tree is the one it saw; any other goes when a turn starts. */
  landing?: Landing;
  /** the setup, check or commit out here, while one is, and a terminated one until the next of its
   * kind. Written at each change of status and stage, and kept across a restart so the next
   * daemon can say what it found still running. */
  runs?: RunState[];
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
  /** back from the archive, or taken over, with its procs not started: a restore is as often one
   * more question as more work, and a question needs no dev server; a directory the person made is
   * theirs, and a dev server in it is something they ask for. Nothing that wakes a worktree starts
   * one that is parked; it goes when someone asks for the preview or its agent writes a file. */
  parked?: boolean;
  /** the person marked it unread to come back to; rings the row until it is next seen */
  unread?: boolean;
  /** what reviewers have written on its PR while the PR is open; absent until any have */
  prComments?: PrCommentsSummary;
  /** its agent showed a plan here, approved or not: a plan is worth keeping, so the row does not
   * archive itself until it lands. Stamped when the card is shown, since a transcript cannot tell one apart. */
  planned?: boolean;
  /** the latest plan its agent showed, relative to the worktree, and the file the agent goes on
   * editing when it keeps one: the composer keeps a way to it from the moment the card shows until
   * the next plan replaces it, since the card and the row that reads it back scroll away while the
   * work goes on. Unset for a plan no file could be
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
  /** its title, as GitHub has it: what a landing by PR says it was when the range it merged
   * cannot be read back */
  title?: string;
  /** GitHub's review decision; absent when the repo requires no review */
  review?: "approved" | "changes_requested" | "review_required";
  /** the checks, folded to one word; absent when the PR has none */
  checks?: "pending" | "pass" | "fail";
  /** GitHub says the merge button would work now */
  mergeable?: boolean;
  /** auto-merge is on: GitHub merges it once its rules allow */
  automerge?: boolean;
  /** the base branch merges through a merge queue: landing the PR is adding it to the queue,
   * which merges it in turn by the queue's own method */
  queue?: boolean;
  /** what the queue is doing with the PR while it is in it: waiting its turn, running the
   * queue's checks, merging, or failed (GitHub drops it from the queue next) */
  queued?: "waiting" | "checking" | "merging" | "failed";
  /** the branch running on the team's own host, as GitHub records it: the link of a status the
   * host named a preview, else the environment of a deployment on the head commit. Absent until
   * the host has built it, and for a repo whose host records nothing. */
  preview?: string;
  /** when GitHub was last asked */
  at: number;
}

/** One remark a reviewer left on a PR, as GitHub has it: a comment on a line of the diff, or a
 * review's own text. Ids are prefixed by kind (`c` a line comment, `r` a review), since GitHub
 * numbers the two apart and a number alone could name either. */
export interface PrComment {
  id: string;
  author: string;
  body: string;
  url: string;
  /** when GitHub has it written, ms */
  at: number;
  path?: string;
  /** the line it is on, or was on before a later push moved the diff under it */
  line?: number;
  /** the first line of a comment on a range */
  startLine?: number;
  /** the line comment this one answers: always its thread's first */
  replyTo?: string;
  /** a review's verdict; absent on a line comment */
  review?: "approved" | "changes_requested" | "commented";
}

/** what reviewers have written on a worktree's PR, as last read: how many remarks and whose, for
 * the line over the box. The remarks themselves are asked for (`pr-comments`) when their page
 * opens; `version` moves each time they change, which is when an open page asks again. */
export interface PrCommentsSummary {
  pr: number;
  count: number;
  /** who wrote them, newest first, the person's own login left out */
  authors: string[];
  version: number;
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
  /** what the model read as still left to do, in a clause, when the work did not read as finished
   * to it; the composer's second line puts "Not ready:" in front of it */
  why?: string;
  /** the suggested commit message: a subject, and a body when there was more to say */
  subject?: string;
  body?: string;
  /** the question was put and never answered (the agent died, the model was unreachable), so no
   * message was written and asking again is worth a press; without it, a missing subject means
   * nothing could answer (an agent with no quick model) and the message is the person's to write */
  unanswered?: true;
  /** HEAD plus the diff's shape when this was written: a tree that no longer matches marks it stale */
  fingerprint: string;
  /** the tree moved since this was written, by a hand or another tool: the message and the
   * sentence still describe the work, the check does not, so the word waits on it running again */
  stale?: true;
}

/** the branch is toyon's to manage: made by create or a spare claim, so removing the
 * worktree may delete it and a title link may be planted beside it. An adopted worktree runs on
 * a branch the person made, in a directory they chose, and neither is toyon's to touch. */
export function hasOwnBranch(wt: Pick<WorktreeInfo, "branch">): boolean {
  return wt.branch.startsWith("toyon/");
}

/** it stopped since anyone last looked, or someone marked it to come back to. A worktree with no
 * record reads as seen. */
export function isUnseen(wt: WorktreeInfo): boolean {
  return wt.unread === true || (wt.lastTurn != null && (wt.seenAt == null || wt.seenAt < wt.lastTurn.at));
}

/** `preparing`: the proc's own setup is running here and no process has been spawned yet; a
 * worktree taking a shared command over from main holds its place this way, and its page keeps
 * reaching main's until the spawn. `unreachable`: alive, but nothing answered on its port before
 * the deadline and it bound no other port either (a server that never listens, or listens
 * somewhere toyon cannot see). `asleep`: stopped by toyon because nobody had looked at the
 * worktree for a while; it keeps its port and comes back on the same one the next time something
 * needs it. */
export type ProcStatus = "preparing" | "starting" | "running" | "unreachable" | "crashed" | "stopped" | "asleep";

/** a proc's state that nobody has to be told about: up, on its way (spawned, or its own setup
 * still running), or main's not started yet ("cold", which the first request wakes). Everything
 * else is down with a reason worth a sentence. No return annotation: the inferred predicate is
 * what lets a caller's else branch drop "cold". */
export const upOrComing = (s: ProcStatus | "cold") =>
  s === "running" || s === "starting" || s === "preparing" || s === "cold";

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

/** Apply one log event to a transcript: drop the last `retract` lines of `proc` (a progress bar
 * that climbed over its own frame), then add `line` when there is one. The daemon's ring and the
 * shell's copy of it both read the same events, so they agree on what a redraw leaves. */
export function applyLog(lines: LogLine[], proc: string, line: string, retract = 0): LogLine[] {
  let out = lines;
  for (let left = retract; left > 0; left--) {
    let i = out.length - 1;
    while (i >= 0 && out[i]?.proc !== proc) i--;
    if (i < 0) break;
    out = out === lines ? [...out] : out;
    out.splice(i, 1);
  }
  if (!line) return out;
  return [...out, { proc, line }];
}

/** "waiting" means blocked on a person (an open ask card), not on the model */
export type AgentStatus = "idle" | "working" | "waiting" | "error";

/** The agent is doing something, or waiting for a person to let it carry on: mid-turn. Every
 * reader that means this rather than "working" specifically says it through here, so a blocked
 * row never reads idle somewhere, which is the mistake that costs: the waiting row is the one
 * that needs you. Undefined is a row with no agent, which is not busy. */
export const isBusy = (status: AgentStatus | undefined): boolean => status === "working" || status === "waiting";

/** When the daemon holds off its machine's idle sleep: while Toyon is in use (an agent working, a
 * question waiting, a shell open from another device), whenever it runs, or never. */
export const KEEP_AWAKE_MODES = ["use", "always", "off"] as const;
export type KeepAwakeMode = (typeof KEEP_AWAKE_MODES)[number];

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

/** one window of a subscription's rate limit, as the agent last read it off a reply: the fraction
 * spent (past 1 when a window is overrun) and when the window empties, in ms */
export interface LimitWindow {
  used: number;
  resetsAt: number;
}

/** How much of its plan an agent's account has used. Per account, not per worktree: every session
 * of the agent reads the same figures off its replies, and the latest to speak is kept. Absent on
 * an API key or a gateway, where no plan window applies. */
export interface AgentLimits {
  /** the agent's own word on the window nearest its cap: whether the next reply goes through */
  status: "allowed" | "allowed_warning" | "rejected";
  /** which window that word is about (`five_hour`, `seven_day`, a per-model week) */
  binding?: string;
  windows: {
    five_hour?: LimitWindow;
    seven_day?: LimitWindow;
    /** the week of the one model billed to its own bucket (Fable, on the plans that offer it):
     * the server carries it on every reply for an account that has it, and not at all for one
     * that does not, so its presence alone says whether there is such a model to spend */
    seven_day_overage_included?: LimitWindow;
  };
  /** when the agent said so, in ms: the figures stand still between replies */
  at: number;
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
  /** the adapter is not on disk and a fetch is the way: `missing` while none was tried (fetched on
   * demand, or boot has not reached it), or what the last one printed. Absent while it is
   * installed or mid-download, and when no install would help (no build for this machine, a
   * sandbox that cannot start), so a surface offers the fetch on this and nothing else. `held`
   * says a rule of the machine's (bun's minimum release age) stopped it, which the person can set
   * aside for one download, so the offer reads install anyway rather than install again. */
  install?: "missing" | { failed: string; held?: true };
  /** fetched only when someone asks for it (a large download), so "not installed" is its resting state */
  onDemand?: boolean;
  /** runs shell commands under an OS sandbox confined to the worktree */
  sandboxed: boolean;
  /** what to read when it has no credential, in its own words ("Claude is not logged in") */
  loginHint?: string;
  /** it has a quick model for the side questions (a name, a recap, the commit message); without
   * one those go unasked, and the commit message is the person's to write */
  quick?: true;
  /** the identity it last reported, from any connection; absent until one has run */
  auth?: AuthStatus;
  /** how much of its plan the account has used, from the last reply any of its sessions heard */
  limits?: AgentLimits;
  /** it advertised ACP's logout method, so settings can offer to sign it out */
  canLogout?: boolean;
  /** the models it advertised the last time a session opened; absent until one has */
  models?: ModelChoice[];
  /** the effort levels it advertised the last time a session opened on a model that has them */
  efforts?: ModelChoice[];
  /** the model it ran the last time a session opened with none asked for: what its default row
   * stands for on this machine, which the row's own words need not say (Claude's reads "Opus"
   * while a `model` in its settings runs something else). Absent until a fresh session has opened. */
  defaultModel?: string;
  /** the effort level it ran the last time a session opened with none asked for, the same way */
  defaultEffort?: string;
  /** what new worktrees of it are asked to run, as picked in the composer; its own default where
   * absent. A request like a worktree record's own: the session applies it against its list. */
  picks?: AgentPicks;
  /** why its last check failed, in words a person can act on: its login hint when it refused for
   * want of a credential, the process's own first line otherwise. Absent once a check succeeds or a
   * session sees it logged in, and before any check has run. */
  checkFailed?: string;
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

/** The row the agent's default stands for, so the picker draws that row in place of both and one
 * model is never two rows. First by what a fresh session that asked for nothing reported running
 * (`runs`, AgentInfo's defaultModel or defaultEffort): the agent's own settings decide its default,
 * and its default row's words do not follow them. Else by the row the default's description
 * names: Claude's model select leads with "Default (recommended)", described as "Opus (1M
 * context)", which is the next row's name. Nothing when neither names a row (Claude's effort
 * default carries no description), and the default row stays. */
export function defaultStandsFor(choices: ModelChoice[], runs?: string): ModelChoice | undefined {
  const own = agentDefault(choices);
  if (!own) return undefined;
  if (runs !== undefined && runs !== own.id) {
    const ran = choices.find((c) => c.id === runs);
    if (ran) return ran;
  }
  if (!own.description) return undefined;
  return choices.find((c) => c !== own && c.name === own.description);
}

/** The id an agent's list carries now for one remembered from an earlier list, or nothing. Ids
 * are the adapter's and move between its versions, and between two processes of one version:
 * Claude's "claude-fable-5-1[1m]" became "fable", its "opus[1m]" became "opus", and one list
 * spells Fable "claude-fable-5-1" where another spells it "fable". The rule is the family word,
 * the id without its vendor prefix, version, date and context hint: taken when the list carries
 * that word as an id of its own, and a bare word asked follows the newest Claude id of its family
 * the list carries, since that is what the bare alias means. Nothing otherwise: "claude-opus-4-7"
 * against a list of "claude-opus-5" and "claude-opus-4-8" names neither, a guess would be a lie,
 * and the caller falls back to the agent's default. An id the list still carries is itself. */
export function relistChoice(id: string, choices: ModelChoice[]): string | undefined {
  if (choices.some((c) => c.id === id)) return id;
  const family = choiceFamily(id);
  if (family === undefined) return undefined;
  if (choices.some((c) => c.id === family)) return family;
  if (family !== bareWord(id)) return undefined;
  let newest: { id: string; version: number } | undefined;
  for (const c of choices) {
    if (choiceFamily(c.id) !== family) continue;
    const version = claudeVersion(c.id);
    if (version !== undefined && (newest === undefined || version > newest.version)) newest = { id: c.id, version };
  }
  return newest?.id;
}

/* a Claude model id in any provider's spelling, down to its family word and version: "claude-opus-5",
 "claude-sonnet-4-5-20250929", Bedrock's "us.anthropic.claude-opus-4-6-v1:0", the older
 "anthropic.claude-3-5-sonnet-20241022-v2:0". A version part is one or two digits, so a date is
 never read as one; the version sits before the family in the older spelling and after it since. */
const CLAUDE_ID =
  /(?:^|[./])claude-(?:(\d{1,2})(?:-(\d{1,2})(?!\d))?-)?([a-z]+)(?:-(\d{1,2})(?!\d)(?:-(\d{1,2})(?!\d))?)?/;

/** the id without its "[1m]" context hint */
function bareWord(id: string): string {
  return id.replace(/\[[^\]]*\]$/, "");
}

/** the family word of a model id: a bare alias ("opus", with or without its "[1m]" hint) or the
 * family of a Claude id; nothing for a shape this does not know ("gpt-5.6-sol") */
function choiceFamily(id: string): string | undefined {
  const bare = bareWord(id);
  const claude = bare.match(CLAUDE_ID)?.[3];
  if (claude) return claude;
  return /^[a-z]+$/.test(bare) ? bare : undefined;
}

/** a Claude id's version as one number to order by (5.1 reads 5.01, 4.8 reads 4.08, a bare
 * "claude-fable-5" reads 5); nothing for a bare alias or a shape this does not know */
function claudeVersion(id: string): number | undefined {
  const m = bareWord(id).match(CLAUDE_ID);
  if (!m) return undefined;
  const major = m[1] ?? m[4];
  if (major === undefined) return undefined;
  const minor = m[1] !== undefined ? m[2] : m[5];
  return Number(major) + Number(minor ?? 0) / 100;
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
  /** uncommitted files in the checkout, from main's tree-state record; 0 until the first read */
  dirty: number;
  /** nothing tracked and nothing untracked: a project made from the picker before anything landed */
  empty: boolean;
  /** why the checkout was not fast-forwarded when origin moved: an uncommitted file the pull would
   * overwrite sits on it, its history diverged from origin's, or it has no upstream to follow */
  stale?: "dirty" | "diverged" | "no-upstream";
  /** when origin last answered a fetch; absent until one has. A count against origin is as true
   * as this fetch, so the rail says so beside the count. */
  fetchedAt?: number;
  /** the last fetch failed, and git's first line about it. Stands ahead of any count, since
   * "0 behind" means nothing while origin cannot be reached; gone with the next fetch that answers. */
  fetchFailed?: string;
  /** the landing op out on the checkout (a pull), while one is */
  shipping?: Shipping;
}

/** the client messages that end in a `shipped` frame: the daemon's word for them */
export type ShipOp = "sync-main" | "commit" | "pull-main" | "land";

/** A landing op out on a row or a trunk, as the daemon has it: one per row at a time, since they
 * run one at a time under the repo lock anyway, and a second press meanwhile is refused. Carried
 * on every frame while it runs, so a tab that did not press it shows the same spinner, and gone
 * from the frame after. `step` is what the op is doing now (committing, rebasing, pushing), so
 * the wait says something. */
export interface Shipping {
  op: ShipOp;
  step?: string;
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
  /** every landing it made, oldest first, whether or not work followed: what the row and main's
   * say landed, and when */
  lands?: LandMark[];
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
  /** the shared-tier procs this row reaches on main rather than running, with main's state of
   * each; absent when none */
  borrowed?: Borrowed[];
  /** procs this row points at a remote whose files it has since changed: the page is not talking
   * to those edits. Read off the runtime, never persisted; absent when none. */
  remoteBehind?: string[];
  /** "idle" for a row toyon does not run */
  agent: AgentStatus;
  /** a stop was pressed and the turn has not ended yet: the agent is asked to stop and may still be
   * winding down (a command it is running holds the interrupt off), so the status stays busy and
   * this says the press landed. Absent otherwise. */
  stopping?: true;
  /** rows the daemon holds open past the turn for something still going under an idle agent: a
   * command it sent to the background and a wakeup it scheduled. The agent is not working, and
   * a message sent now starts a turn as usual, but the worktree is not done either. Absent when
   * none. */
  background?: number;
  /** the earliest wakeup the agent scheduled, as a time, while one is pending: the row says
   * when the agent comes back on its own */
  wakes?: number;
  /** the agent's terminal login is running here, or failed and still shows why: the login tab */
  login: boolean;
  /** commits ahead/behind the default branch, from the worktree's tree-state record, the same
   * one its git-status frames carry, so the rail and the changes panel agree; absent until the
   * first read, and on a detached worktree, which has nothing to count against. On main, `behind`
   * counts against its upstream as of the last fetch (the daemon fetches now and then while main
   * is on screen), and `ahead` is absent: what main trails is origin, and what it leads is
   * nobody's business here. */
  ahead?: number;
  behind?: number;
  /** commits here that the branch on origin does not have, counted only while a PR is open: the
   * work the PR is missing, which `update` pushes. Absent otherwise. */
  unpushed?: number;
  /** uncommitted file count, from the same tree-state record; absent until the first read */
  dirty?: number;
  /** chat messages waiting behind the current turn */
  queued?: number;
  /** a sync from main pressed while the agent was mid-turn with uncommitted work: it runs once
   * the turn ends, and a press meanwhile calls it off */
  syncQueued?: boolean;
  /** the agent's last reported figures here: context in use of the window, and the session's
   * spend when the agent prices itself. From the transcript, so a cold worktree has them too. */
  usage?: { used: number; size: number; cost?: number };
  /** a turn finished here since the last time anyone looked at it. The rail rings the dot: green
   * alone cannot separate "just finished" from "untouched for a week". */
  unseen?: boolean;
  /** the chat's transcript on disk: what another tool is pointed at to read this chat. Absent on
   * a found worktree, which has no chat, and on one nothing has been said in yet, so the rows that
   * offer the file are not offered a file that is not there. */
  transcript?: string;
  /** the agent's own session id here, once it has opened one: what its CLI resumes outside toyon */
  sessionId?: string;
  /** the landing op out on the row, while one is; a chat sent meanwhile waits in the queue */
  shipping?: Shipping;
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
  /** the text around the first word matched, whitespace collapsed, with an ellipsis where it was cut */
  text: string;
  /** where each of the query's words sits in `text`, start and length, for the words that fit: the
   * query's words all appear in the message, in any order, and a word past the cut is not marked */
  match: Array<[number, number]>;
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
  /** lines added / deleted; absent for binary files and untracked directories, and in a core
   * git-status frame, where counts have not been read yet */
  add?: number;
  del?: number;
}

/** what the last turn changed and the commit holding the tree it started from: the before side
 * of each file's diff, which a `read-file` names as its `since` */
export interface TurnChanges {
  base: string;
  files: GitFileStatus[];
}

/** the slower tier of a worktree's git state, what costs a diff per file: read only for a
 * subscriber, behind the core frame */
export interface GitExtras {
  /** files committed on this branch over its base; empty when `ahead` is 0 */
  committed: GitFileStatus[];
  /** the last turn's own files when narrower than `files`; absent on a clean tree, on main, and
   * when the turn cannot be told apart from work taken in from the base */
  turn?: TurnChanges;
}

/** One worktree's git state as the daemon's tree-state owner holds it and as a `git-status`
 * frame carries it. `version` counts the worktree's states for the daemon's life, from 1: a
 * frame carries the number of the state it was read from, the two tiers go out on their own
 * clocks, and a shell drops a frame below the number it holds. The core (`files` as path and
 * status, the counts, `head`) is in every frame; `extras` rides when the frame carries that tier,
 * and then `files` carry their line counts too. */
export interface GitInfo {
  version: number;
  files: GitFileStatus[];
  /** commits ahead of / behind the base; absent on main, which has nothing to count against */
  ahead?: number;
  behind?: number;
  /** commits origin's copy of the branch lacks, counted only while a PR is open */
  unpushed?: number;
  /** HEAD's sha; the history tab re-reads its log when this moves */
  head?: string;
  extras?: GitExtras;
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

/** a commit as a line's blame names it: who, when, and what the commit said */
export interface BlameCommit {
  sha: string;
  author: string;
  /** the author's address as the commit carries it, without the brackets */
  email: string;
  /** author date, epoch ms */
  at: number;
  subject: string;
  /** where to read it on the web: its pull request when the subject names one, the commit's own
   * page otherwise. Absent when the origin is not on GitHub, or origin does not have the commit */
  url?: string;
  /** the pull request `url` opens, when it is one */
  pr?: number;
}

/** Who last touched each line of a file. `lines[i]` indexes `commits` for line i+1, or is -1 for
 * a line not committed yet; empty for a file git cannot blame (untracked, or not there). */
export interface FileBlame {
  commits: BlameCommit[];
  lines: number[];
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
   * interchange format every colour scheme since ANSI has shipped. Only the scrim and the shadow
   * are derived, in themeToCssVars, because those are the two a theme was never really deciding. */
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
  /** The colour that carries "you are on this one": the active worktree, an `on` tab, a checked
   * box. Its own hex rather than a key into the seven, because a theme may bring a brand colour
   * that is none of them (an imported VS Code theme's badge or focus border), and because red is
   * a crash and green is working, so a selection painted in either reads as that status. A theme
   * that names none selects in its orange; Toyon and the other built-ins name none. */
  accent?: ThemeColor;
  /** The colour a link in prose wears: a trip out to the web, as against a file link, which stays
   * in the text's tier. A theme that names none links in its blue. Toyon names a quieter one: its
   * blue carries alone as a status letter, but a reply ends in a line of sources, and at that
   * weight a line of them shouts against the warm ground. A VS Code import brings its
   * textLink.foreground. */
  link?: ThemeColor;
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
