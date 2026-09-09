// Worktree lifecycle and landing: everything that decides what happens to a worktree. The
// transport layer (server/handlers.ts) calls in here and shapes replies; git/, runtime/ and the
// spare pool do the work.

import { existsSync, lstatSync, readlinkSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  AgentStatus,
  CommitEntry,
  DiscoveredWorktree,
  GitFileStatus,
  ImageInput,
  PasteInput,
  PickMeta,
  RepoInfo,
  WorktreeInfo,
  WorktreeStatus,
} from "@toyon/shared";
import { attachmentsDirFor } from "../agent/attachments.ts";
import { canonical } from "../agent/bounds.ts";
import type { AgentRegistry } from "../agent/registry.ts";
import { makeNamer } from "../agent/tasks.ts";
import { transcriptPathFor } from "../agent/transcript.ts";
import { UserError } from "../core/errors.ts";
import type { Hub } from "../core/hub.ts";
import { fireAndForget, log } from "../core/log.ts";
import type { Paths } from "../core/paths.ts";
import type { StateStore } from "../core/state.ts";
import { git, gitOrThrow, run } from "../git/exec.ts";
import { commitWorktree, mergeToMain, type ShipResult, shipWorktree, syncFromMain } from "../git/land.ts";
import { withRepoLock } from "../git/lock.ts";
import { logCommits, commitFiles as readCommitFiles } from "../git/log.ts";
import { aheadBehind, committedFiles, statusFiles, statusFilesWithCounts } from "../git/status.ts";
import { isInside } from "../repos/create.ts";
import { allocateProxyPort, releasePort } from "../runtime/ports.ts";
import { resolveRun } from "../runtime/profile.ts";
import { DEFAULT_AGENT_ID, type RuntimeRegistry } from "../runtime/registry.ts";
import { runSetup } from "../runtime/setup.ts";
import { discoverIn } from "./discover.ts";
import { cleanTitle, shortId, slugify, VARIANT_LENSES } from "./naming.ts";
import { SparePool } from "./spare.ts";

/** Gitignored local config a worktree needs and git will never bring over. Absent secrets fail
 * deep inside app code rather than as missing config (an empty AUTH_SECRET reads as a zero-length
 * HMAC key), so copy whatever the base checkout actually has. */
const LOCAL_CONFIG_FILES = [".env", ".env.local", ".env.development", ".env.development.local", ".dev.vars"];

export type Variant = { group: string; index: number; of: number };

/** what `git status` + ahead/behind say about one worktree */
export interface GitInfo {
  files: GitFileStatus[];
  committed?: GitFileStatus[];
  ahead?: number;
  behind?: number;
  /** HEAD's sha, so the history tab knows when its log went stale */
  head?: string;
}

export interface CreateOpts {
  /** the shell tab that asked; stored as createdBy so only that tab auto-focuses the result */
  createdBy?: string;
  /** registry id; the daemon's default when absent */
  agent?: string;
  baseWorktreeId?: string;
  variant?: Variant;
  context?: string;
  pick?: PickMeta;
  /** one of the repo's profiles; the repo's default when absent */
  profile?: string;
  images?: ImageInput[];
  pastes?: PasteInput[];
}

export interface WorktreeServiceDeps {
  state: StateStore;
  hub: Hub;
  runtime: RuntimeRegistry;
  paths: Paths;
  agents: AgentRegistry;
  /** task → short kebab-case name (the worktree's own agent by default; tests inject a stub) */
  namer?: (prompt: string, wt: WorktreeInfo) => Promise<string | null>;
}

export class WorktreeService {
  readonly spare: SparePool;
  private countsCache = new Map<string, { ahead?: number; behind?: number; dirty: number; at: number }>();
  /** per repo, because discovery asks git once for the whole repo rather than once per worktree */
  private discoverCache = new Map<string, { rows: DiscoveredWorktree[]; at: number }>();
  /** the agent status each worktree last reported, so a turn's end is an edge and not a level */
  private lastAgentStatus = new Map<string, AgentStatus>();

  constructor(private d: WorktreeServiceDeps) {
    this.spare = new SparePool({
      state: d.state,
      hub: d.hub,
      runtime: d.runtime,
      paths: d.paths,
      setupAndStart: (wt, repo) => this.setupAndStart(wt, repo),
      remove: (id) => this.remove(id, true),
    });
    // worktrees claimed before links existed get theirs at boot
    for (const wt of d.state.worktrees) this.refreshLink(wt);
    // The rail rings a worktree whose turn ended while nobody was looking, so the edge into idle
    // is the moment worth recording. Only a busy → idle edge counts: a session reports idle at
    // birth too, and stamping that would ring every worktree the daemon has ever started.
    // Subscribed here rather than in the ws layer because this listener has to run before the one
    // that broadcasts statuses, and services are constructed before the server.
    d.hub.on("agentStatus", (worktreeId, status) => {
      const prev = this.lastAgentStatus.get(worktreeId) ?? "idle";
      this.lastAgentStatus.set(worktreeId, status);
      if (status !== "idle" || (prev !== "working" && prev !== "waiting")) return;
      const wt = d.state.worktree(worktreeId);
      // gone already if the worktree was removed mid-turn; nothing to stamp
      if (!wt) return;
      wt.lastTurnAt = Date.now();
      d.state.save();
    });
  }

  // ---- create / remove / rename ----

  async create(repoId: string, prompt: string, opts: CreateOpts = {}): Promise<WorktreeInfo> {
    const { variant, context, pick, images, pastes } = opts;
    const repo = this.d.state.requireRepo(repoId);
    // validated up front: an unknown or uninstalled agent is a toast now, not a dead worktree later
    const agent = this.d.agents.require(opts.agent ?? this.d.state.defaultAgent ?? DEFAULT_AGENT_ID).id;
    const profile = this.checkProfile(repo, opts.profile);
    // variants share a name base so they read as siblings in the list
    let slug = variant ? `${slugify(prompt, false)}-v${variant.index}` : slugify(prompt);
    if (variant && (await git(repo.path, "show-ref", "--verify", `refs/heads/toyon/${slug}`)).ok) {
      slug = `${slug}-${shortId().slice(0, 3)}`;
    }
    const branch = `toyon/${slug}`;

    // fork point: main's branch by default, or the base worktree's branch (stacking)
    const base = opts.baseWorktreeId ? this.d.state.worktree(opts.baseWorktreeId) : undefined;
    const fromMain = !base || base.kind === "main";

    // perspective-diverse variants: same goal, different emphasis per attempt
    const agentPrompt =
      variant && variant.of >= 2
        ? `${prompt}\n\n${VARIANT_LENSES[(variant.index - 1) % VARIANT_LENSES.length]}`
        : prompt;

    // fast path: claim the pre-warmed spare (main-based tasks only). Its runtime — agent
    // included — already exists, so the task's first message goes to the spare's agent.
    if (fromMain) {
      const claimed = await this.spare.claim(repoId, branch, slug);
      if (claimed) {
        if (variant) claimed.variant = variant;
        if (opts.createdBy) claimed.createdBy = opts.createdBy;
        // the spare's agent has no process yet; it reads the stamp on its first prompt
        claimed.agent = agent;
        this.refreshLink(claimed);
        // the spare was warmed under the default profile; another one means its procs restart
        // (the agent stays, and gets the prompt now rather than after the restart)
        if (profile !== undefined && profile !== resolveRun(repo, claimed).profile) {
          claimed.profile = profile;
          this.restartProcs(claimed, repo);
        }
        this.d.state.save();
        this.d.hub.emit("worktreesChanged");
        this.d.runtime.ensureAgent(claimed).agent.send(agentPrompt, { context, pick, images, pastes });
        this.scheduleNaming(claimed, prompt, repo, variant);
        return claimed;
      }
    }

    const wtPath = join(this.d.paths.worktreesDir, repo.name, slug);
    const baseBranch = fromMain ? repo.defaultBranch : base!.branch;
    await withRepoLock(repo.path, () => gitOrThrow(repo.path, "worktree", "add", "-b", branch, wtPath, baseBranch));

    const wt: WorktreeInfo = {
      id: shortId(),
      repoId,
      path: wtPath,
      branch,
      kind: "worktree",
      proxyPort: await allocateProxyPort(),
      title: slug,
      createdAt: Date.now(),
      agent,
      ...(variant ? { variant } : {}),
      ...(opts.createdBy ? { createdBy: opts.createdBy } : {}),
      ...(profile !== undefined ? { profile } : {}),
    };
    this.d.state.addWorktree(wt);
    this.d.hub.emit("worktreesChanged");

    // setup + procs warm in the background; the agent starts immediately
    // RuntimeRegistry.start emits worktreesChanged once the procs are up
    fireAndForget(wt.id, this.setupAndStart(wt, repo, base?.path ?? repo.path), "setup + start");
    this.d.runtime.ensureAgent(wt).agent.send(agentPrompt, { context, pick, images, pastes });
    this.scheduleNaming(wt, prompt, repo, variant);
    return wt;
  }

  /** Promote a worktree git knows about into one toyon runs.
   *
   * The directory already exists and someone else made it, so this allocates a port, records it and
   * starts the procs. It deliberately does not run `toyon.json`'s setup commands (see
   * `setupAndStart`) and does not start an agent: take-over is not a task, and the agent comes up
   * on the first message like it does anywhere else. */
  /** The discovered row at this path as it stands right now, or a toast.
   *
   * Never trust a path the client sends: a discovered worktree has no id, so the path is the whole
   * address, and it must still be on the list the daemon would push. Re-derived rather than read
   * from the cache because the frame the person clicked can be seconds old, and a lock is the only
   * thing standing between us and another agent's working directory. */
  private async requireDiscovered(repoId: string, repoPath: string, target: string): Promise<DiscoveredWorktree> {
    const rows = await discoverIn(repoId, repoPath, this.d.state.worktrees);
    const found = rows.find((r) => canonical(r.path) === target);
    if (!found) throw new UserError("that worktree is gone, or toyon already has it");
    return found;
  }

  /** the absolute path of a discovered worktree, once it is established it is still one */
  async discoveredPath(repoId: string, path: string): Promise<string> {
    const repo = this.d.state.requireRepo(repoId);
    return (await this.requireDiscovered(repoId, repo.path, canonical(path))).path;
  }

  async adopt(repoId: string, path: string, createdBy?: string): Promise<WorktreeInfo> {
    const repo = this.d.state.requireRepo(repoId);
    const target = canonical(path);
    // the whole verify-then-record step holds the lock: outside it this races `worktree remove`
    // and leaves a record pointing at a directory that is already gone
    const wt = await withRepoLock(repo.path, async () => {
      const found = await this.requireDiscovered(repoId, repo.path, target);
      if (found.locked) {
        throw new UserError(`${found.name} is held by another tool${found.lockReason ? `: ${found.lockReason}` : ""}`);
      }
      // land, ship, merge and rename all address a branch; a detached worktree has none to name
      if (!found.branch) throw new UserError(`${found.name} is detached: check out a branch in it first`);
      // procs and a dep clone inside the main checkout would land in its working tree, where the
      // agent's file tools and git status would both start seeing them
      const enclosing = [...this.d.state.repos, ...this.d.state.worktrees].find((r) =>
        isInside(target, canonical(r.path)),
      );
      if (enclosing) throw new UserError(`${found.name} sits inside ${enclosing.path}, which toyon already manages`);
      const rec: WorktreeInfo = {
        id: shortId(),
        repoId,
        path: found.path,
        branch: found.branch,
        kind: "worktree",
        proxyPort: await allocateProxyPort(),
        title: found.name,
        createdAt: Date.now(),
        agent: this.d.agents.require(this.d.state.defaultAgent ?? DEFAULT_AGENT_ID).id,
        ...(createdBy ? { createdBy } : {}),
      };
      this.d.state.addWorktree(rec);
      return rec;
    });
    this.invalidateDiscovered();
    this.d.hub.emit("worktreesChanged");
    // slow, and nothing above depends on it: outside the lock, like create()'s own setup
    fireAndForget(wt.id, this.setupAndStart(wt, repo, repo.path, { setupCommands: false }), "adopt setup");
    return wt;
  }

  /** a profile name the repo actually has, or undefined for "the default"; a typo is a toast */
  private checkProfile(repo: RepoInfo, name: string | undefined): string | undefined {
    if (name === undefined) return undefined;
    if (!repo.config.profiles?.[name]) throw new UserError(`no profile "${name}" in ${repo.name}'s toyon.json`);
    return name;
  }

  /** procs and proxy come back under the worktree's current profile; the agent is untouched */
  private restartProcs(wt: WorktreeInfo, repo: RepoInfo) {
    fireAndForget(
      wt.id,
      this.d.runtime.stopProcs(wt.id).then(() => this.d.runtime.start(wt, repo)),
      "profile restart",
    );
  }

  /** Run this worktree under another of the repo's profiles. Only its procs restart. */
  setProfile(worktreeId: string, name: string) {
    const { wt, repo } = this.d.state.requireWorktreeWithRepo(worktreeId);
    if (wt.kind === "spare") throw new UserError("no profile for a spare worktree");
    const profile = this.checkProfile(repo, name);
    if (profile === wt.profile) return;
    wt.profile = profile;
    this.d.state.save();
    this.d.hub.emit("worktreesChanged");
    this.restartProcs(wt, repo);
  }

  /** Async pretty-naming: solo worktrees rename directly; variant groups rename together
   * (index 1 runs the Haiku call, then every sibling becomes <name>-v<index>). */
  private scheduleNaming(wt: WorktreeInfo, prompt: string, repo: RepoInfo, variant?: Variant) {
    if (!variant) {
      fireAndForget(
        wt.id,
        (this.d.namer ?? makeNamer(this.d.runtime))(prompt, wt).then((name) => {
          if (name) return this.rename(wt.id, name);
        }),
        "auto-naming",
      );
      return;
    }
    if (variant.index !== 1) return; // sibling 1 names the whole group
    fireAndForget(
      wt.id,
      (this.d.namer ?? makeNamer(this.d.runtime))(prompt, wt).then(async (name) => {
        if (!name) return;
        for (const sibling of this.d.state.worktrees.filter((w) => w.variant?.group === variant.group)) {
          await this.rename(sibling.id, `${name}-v${sibling.variant!.index}`).catch((e) => {
            log.warn(sibling.id, "variant rename failed", e);
          });
        }
      }),
      "auto-naming",
    );
  }

  async remove(worktreeId: string, allowSpare = false): Promise<void> {
    const wt = this.d.state.worktree(worktreeId);
    if (!wt || wt.kind === "main" || (wt.kind === "spare" && !allowSpare)) return;
    const repo = this.d.state.requireRepo(wt.repoId);
    // the agent first (inside runtime.stop): it may be mid-turn in the directory about to be
    // deleted, and its session-info callback would re-add the session entry removed below
    await this.d.runtime.stop(worktreeId);
    await withRepoLock(repo.path, () => gitOrThrow(repo.path, "worktree", "remove", "--force", wt.path));
    this.dropLink(wt);
    this.d.state.removeWorktree(worktreeId);
    try {
      rmSync(transcriptPathFor(this.d.paths.transcriptsDir, worktreeId), { force: true });
      rmSync(attachmentsDirFor(this.d.paths.attachmentsDir, worktreeId), { recursive: true, force: true });
    } catch (e) {
      log.warn(worktreeId, "could not delete transcript or attachments", e);
    }
    releasePort(wt.proxyPort);
    this.d.hub.emit("worktreesChanged");
  }

  async rename(worktreeId: string, title: string): Promise<void> {
    const wt = this.d.state.worktree(worktreeId);
    if (!wt || wt.kind === "main") return;
    const repo = this.d.state.requireRepo(wt.repoId);
    const clean = cleanTitle(title);
    if (!clean) return;
    await withRepoLock(repo.path, async () => {
      let branch = `toyon/${clean}`;
      if (branch !== wt.branch) {
        // avoid collisions with an existing branch
        let n = 2;
        while (!(await git(wt.path, "branch", "-m", wt.branch, branch)).ok) {
          if (n > 5) return;
          branch = `toyon/${clean}-${n++}`;
        }
        wt.branch = branch;
      }
      wt.title = clean;
    });
    this.refreshLink(wt);
    this.d.state.save();
    this.d.hub.emit("worktreesChanged");
  }

  /** `<repo>/<title>` → the directory, when its own name is not the title (a claimed spare keeps
   * wt-xxxx). The terminal and editor links show the link; git and procs keep the real path.
   * Moving the directory for real would restart the procs and the agent session (its cwd). */
  private refreshLink(wt: WorktreeInfo) {
    // Only toyon's own branches get a link. An adopted worktree sits in a directory the person
    // chose, and `desired` would put a symlink next to it under a name they never asked for
    // (adopting ~/Projects/app-editor-pane on branch `editor-pane` would create
    // ~/Projects/editor-pane, and again on every boot).
    if (!wt.branch.startsWith("toyon/")) return;
    // the branch tail rather than the title: titles may repeat (three tasks named alike), branches
    // never do (rename suffixes them)
    const name = wt.branch.replace(/^toyon\//, "");
    const desired = wt.kind === "worktree" ? join(dirname(wt.path), name) : wt.path;
    if (wt.linkPath && wt.linkPath !== desired) this.dropLink(wt);
    if (desired === wt.path) return;
    try {
      const st = lstatSync(desired, { throwIfNoEntry: false });
      // a real directory, or another worktree's link, keeps the name
      if (st && !(st.isSymbolicLink() && readlinkSync(desired) === wt.path)) return;
      if (!st) symlinkSync(wt.path, desired);
      wt.linkPath = desired;
    } catch (e) {
      log.warn(wt.id, "could not link the title to the directory", e);
    }
  }

  private dropLink(wt: WorktreeInfo) {
    const p = wt.linkPath;
    wt.linkPath = undefined;
    if (!p) return;
    try {
      if (lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(p);
    } catch (e) {
      log.warn(wt.id, "could not remove the title link", e);
    }
  }

  /** Declare a variant the winner: remove its siblings, drop its variant badge. */
  async pickVariant(worktreeId: string): Promise<void> {
    const wt = this.d.state.worktree(worktreeId);
    if (!wt?.variant) return;
    const group = wt.variant.group;
    const siblings = this.d.state.worktrees.filter((w) => w.variant?.group === group && w.id !== worktreeId);
    for (const sibling of siblings) {
      await this.remove(sibling.id).catch((e) => log.warn(sibling.id, "could not remove variant sibling", e));
    }
    delete wt.variant;
    this.d.state.save();
    this.d.hub.emit("worktreesChanged");
  }

  /** Ephemeral local octopus merge of several worktree branches, as its own preview worktree. */
  async combine(worktreeIds: string[]): Promise<WorktreeInfo> {
    const wts = worktreeIds
      .map((id) => this.d.state.worktree(id))
      .filter((w): w is WorktreeInfo => !!w && w.kind !== "main");
    if (wts.length < 2) throw new UserError("select at least two worktrees to combine");
    const repoId = wts[0]!.repoId;
    if (!wts.every((w) => w.repoId === repoId)) throw new UserError("worktrees must belong to one repo");
    const repo = this.d.state.requireRepo(repoId);

    // graft names are the recipe: <a>+<b> (the ⧉ icon marks it as a graft); random suffix only on collision
    let slug = wts
      .map((w) => w.title.split("-")[0])
      .join("+")
      .slice(0, 40);
    if ((await git(repo.path, "show-ref", "--verify", `refs/heads/toyon/${slug}`)).ok) {
      slug = `${slug.slice(0, 34)}-${shortId().slice(0, 4)}`;
    }
    const branch = `toyon/${slug}`;
    const wtPath = join(this.d.paths.worktreesDir, repo.name, slug);

    await withRepoLock(repo.path, async () => {
      await gitOrThrow(repo.path, "worktree", "add", "-b", branch, wtPath, repo.defaultBranch);
      const m = await git(wtPath, "merge", "--no-edit", ...wts.map((w) => w.branch));
      if (!m.ok) {
        await git(wtPath, "merge", "--abort");
        await git(repo.path, "worktree", "remove", "--force", wtPath);
        await git(repo.path, "branch", "-D", branch);
        throw new UserError(`branches conflict: these worktrees can't be grafted cleanly (${m.err.slice(0, 200)})`);
      }
    });

    // a graft runs the sources' profile when they agree, else the default
    const profiles = new Set(wts.map((w) => w.profile));
    const profile = profiles.size === 1 ? wts[0]!.profile : undefined;
    const wt: WorktreeInfo = {
      id: shortId(),
      repoId,
      path: wtPath,
      branch,
      kind: "combined",
      proxyPort: await allocateProxyPort(),
      title: slug,
      createdAt: Date.now(),
      sources: wts.map((w) => w.id),
      ...(profile !== undefined ? { profile } : {}),
    };
    this.d.state.addWorktree(wt);
    this.d.hub.emit("worktreesChanged");
    fireAndForget(wt.id, this.setupAndStart(wt, repo, wts[0]!.path), "setup + start");
    return wt;
  }

  // ---- setup ----

  /** Clone deps from the base checkout, run the repo's setup commands, then start the runtime.
   *
   * `setupCommands: false` keeps the two copies (both no-ops when the destination already has the
   * files) and skips `toyon.json`'s `setup` list, which has no such guard. Adoption uses it: those
   * commands are `bun install`, migrations, `docker compose up`, and a directory someone has been
   * working in is the last place to re-run them behind their back. */
  async setupAndStart(
    wt: WorktreeInfo,
    repo: RepoInfo,
    depsSource = repo.path,
    { setupCommands = true }: { setupCommands?: boolean } = {},
  ): Promise<void> {
    // Copy-on-write where the fs allows it: `cp -c` (APFS clonefile), then GNU `--reflink=auto`
    // (btrfs/XFS), then a plain recursive copy (ext4). The log line records which
    // path ran and how long the fallback copy takes per worktree.
    const srcNm = join(depsSource, "node_modules");
    const dstNm = join(wt.path, "node_modules");
    if (existsSync(srcNm) && !existsSync(dstNm)) {
      const started = Date.now();
      const attempts: [string, string[]][] = [
        ["clonefile", ["-Rc", srcNm, dstNm]],
        ["reflink", ["-R", "--reflink=auto", srcNm, dstNm]],
        ["copy", ["-R", srcNm, dstNm]],
      ];
      for (const [how, args] of attempts) {
        if ((await run("cp", args, wt.path)).ok) {
          this.d.hub.emit("log", wt.id, "setup", `deps via ${how} in ${Date.now() - started}ms`);
          break;
        }
        await run("rm", ["-rf", dstNm], wt.path);
      }
    }
    for (const f of LOCAL_CONFIG_FILES) {
      const src = join(depsSource, f);
      if (!existsSync(src) || existsSync(join(wt.path, f))) continue;
      const r = await run("cp", [src, join(wt.path, f)], wt.path);
      if (r.ok) this.d.hub.emit("log", wt.id, "setup", `copied ${f}`);
      else log.warn(wt.id, `could not copy ${f}`, r.err);
    }
    // `bun install` and friends can take a minute: async, so every preview and agent stream keeps
    // flowing while a new worktree warms up
    for (const cmd of setupCommands ? (repo.config.setup ?? []) : []) {
      const code = await runSetup(cmd, wt.path, (line) => this.d.hub.emit("log", wt.id, "setup", line));
      if (code !== 0) this.d.hub.emit("log", wt.id, "setup", `setup failed (exit ${code}): ${cmd}`);
    }
    await this.d.runtime.start(wt, repo);
  }

  // ---- landing ----

  setPrUrl(worktreeId: string, url: string) {
    const wt = this.d.state.worktree(worktreeId);
    if (!wt) return;
    wt.prUrl = url;
    this.d.state.save();
    this.d.hub.emit("worktreesChanged");
  }

  setLanded(worktreeId: string, landed: boolean) {
    const wt = this.d.state.worktree(worktreeId);
    if (!wt || wt.landed === landed || (landed && wt.kind === "main")) return;
    wt.landed = landed;
    this.d.state.save();
    this.d.hub.emit("worktreesChanged");
  }

  private landable(worktreeId: string, verb: string): { wt: WorktreeInfo; repo: RepoInfo } {
    const pair = this.d.state.requireWorktreeWithRepo(worktreeId);
    if (pair.wt.kind === "main") throw new UserError(`${verb} from a worktree, not main`);
    return pair;
  }

  /** push + PR. Not under the repo lock: it holds `git push` + `gh` for seconds. */
  async ship(worktreeId: string): Promise<ShipResult> {
    const { wt, repo } = this.landable(worktreeId, "ship");
    const result = await shipWorktree(wt.path, wt.branch, repo.defaultBranch);
    if (result.prCreated && result.url) this.setPrUrl(wt.id, result.url);
    return result;
  }

  /** merge into main locally. Returns the worktrees the UI should offer to clean up: landing a
   * graft lands its sources; landing a variant ends the tournament. */
  async merge(worktreeId: string): Promise<{ result: ShipResult; removeIds?: string[] }> {
    const { wt, repo } = this.landable(worktreeId, "merge");
    // touches the main checkout: serialize with spare refresh / worktree add on the same repo
    const result = await withRepoLock(repo.path, () => mergeToMain(wt.path, wt.branch, repo.path, repo.defaultBranch));
    if (!result.ok) return { result };
    this.setLanded(wt.id, true);
    let removeIds: string[];
    if (wt.kind === "combined") {
      removeIds = [wt.id, ...(wt.sources ?? []).filter((id) => this.d.state.worktree(id))];
    } else if (wt.variant) {
      const group = wt.variant.group;
      removeIds = this.d.state.worktrees.filter((w) => w.variant?.group === group).map((w) => w.id);
    } else {
      removeIds = [wt.id];
    }
    return { result, removeIds };
  }

  async sync(worktreeId: string): Promise<{ result: ShipResult; defaultBranch: string }> {
    const { wt, repo } = this.landable(worktreeId, "sync");
    const result = await withRepoLock(repo.path, () => syncFromMain(wt.path, repo.defaultBranch));
    return { result, defaultBranch: repo.defaultBranch };
  }

  async commit(worktreeId: string, message: string): Promise<ShipResult> {
    const wt = this.d.state.requireWorktree(worktreeId);
    const m = message.trim();
    if (!m) throw new UserError("commit message required");
    return commitWorktree(wt.path, m);
  }

  // ---- queries ----

  /** the default branch moved: badge counts are stale */
  invalidateCounts() {
    this.countsCache.clear();
  }

  /** something under `.git/worktrees` changed: git's list is no longer what we last read */
  invalidateDiscovered() {
    this.discoverCache.clear();
  }

  /** Worktrees git knows about that toyon does not, across every registered repo.
   *
   * Cached per repo on the same 10s floor as `counts()`: this runs on every `worktreesChanged`,
   * which fires on every proc event, and a dev-server log line should not shell out to git. The
   * watcher clears the cache when a worktree actually appears or goes, so the TTL bounds how often
   * we ask when nothing has happened, not how long a real change stays invisible. */
  async discovered(): Promise<DiscoveredWorktree[]> {
    const perRepo = await Promise.all(
      this.d.state.repos.map(async (repo) => {
        const cached = this.discoverCache.get(repo.id);
        if (cached && Date.now() - cached.at < 10_000) return cached.rows;
        try {
          const rows = await discoverIn(repo.id, repo.path, this.d.state.worktrees);
          this.discoverCache.set(repo.id, { rows, at: Date.now() });
          return rows;
        } catch (e) {
          log.warn(repo.id, "could not list this repo's worktrees", e);
          return cached?.rows ?? [];
        }
      }),
    );
    return perRepo.flat();
  }

  private async counts(wt: WorktreeInfo): Promise<{ ahead?: number; behind?: number; dirty?: number }> {
    const cached = this.countsCache.get(wt.id);
    if (cached && Date.now() - cached.at < 10_000) return cached;
    try {
      const ab =
        wt.kind === "main" ? {} : await aheadBehind(wt.path, this.d.state.requireRepo(wt.repoId).defaultBranch);
      const fresh = { ...ab, dirty: (await statusFiles(wt.path)).length, at: Date.now() };
      this.countsCache.set(wt.id, fresh);
      return fresh;
    } catch {
      return cached ?? {};
    }
  }

  /** the working-tree state the changes panel shows (subscribe, edits, ref ticks). Also the one
   * place the `landed` badge is cleared: new work after a merge means it is no longer landed. */
  async gitStatus(worktreeId: string): Promise<GitInfo | null> {
    const wt = this.d.state.worktree(worktreeId);
    if (!wt || wt.kind === "spare") return null;
    try {
      const defaultBr = this.d.state.requireRepo(wt.repoId).defaultBranch;
      const [files, counts, head] = await Promise.all([
        statusFilesWithCounts(wt.path),
        wt.kind === "main" ? Promise.resolve({}) : aheadBehind(wt.path, defaultBr),
        git(wt.path, "rev-parse", "HEAD"),
      ]);
      const ahead = (counts as { ahead?: number }).ahead ?? 0;
      const committed = wt.kind !== "main" && ahead > 0 ? await committedFiles(wt.path, defaultBr) : undefined;
      if (wt.landed && (files.length > 0 || ahead > 0)) this.setLanded(wt.id, false);
      return { files, committed, head: head.ok ? head.out : undefined, ...counts };
    } catch (e) {
      log.warn(worktreeId, "git status failed", e);
      return null;
    }
  }

  /** the history tab's commit list. Unlike gitStatus this is asked for, not pushed: the panel
   * requests it when the tab is opened and after a commit, so a worktree nobody is reviewing
   * never pays for it. */
  async gitLog(worktreeId: string): Promise<CommitEntry[]> {
    const wt = this.d.state.worktree(worktreeId);
    if (!wt || wt.kind === "spare") return [];
    const defaultBr = this.d.state.requireRepo(wt.repoId).defaultBranch;
    return logCommits(wt.path, defaultBr);
  }

  /** the files one commit touched, on expanding it in the history tab */
  async commitFiles(worktreeId: string, sha: string): Promise<GitFileStatus[]> {
    const wt = this.d.state.worktree(worktreeId);
    if (!wt || wt.kind === "spare") return [];
    return readCommitFiles(wt.path, sha);
  }

  /** someone is looking at this worktree right now: clear its unseen ring */
  markSeen(worktreeId: string) {
    const wt = this.d.state.requireWorktree(worktreeId);
    if (wt.seenAt != null && wt.lastTurnAt != null && wt.seenAt >= wt.lastTurnAt) return;
    wt.seenAt = Date.now();
    this.d.state.save();
    this.d.hub.emit("worktreesChanged");
  }

  async statuses(): Promise<WorktreeStatus[]> {
    return Promise.all(
      this.d.state.worktrees
        .filter((wt) => wt.kind !== "spare")
        .map(async (wt) => {
          const rt = this.d.runtime.get(wt.id);
          const { ahead, behind, dirty } = await this.counts(wt);
          return {
            worktree: wt,
            procs: rt?.procs?.states() ?? [],
            agent: rt?.agent.status ?? "idle",
            ahead,
            behind,
            dirty,
            queued: rt?.agent.queueLength || undefined,
            unseen: isUnseen(wt) || undefined,
          };
        }),
    );
  }
}

/** a turn finished here since anyone last looked. A worktree with no `lastTurnAt` reads as seen,
 * so worktrees that predate the field do not all light up the first time the daemon restarts. */
function isUnseen(wt: WorktreeInfo): boolean {
  return wt.lastTurnAt != null && (wt.seenAt == null || wt.seenAt < wt.lastTurnAt);
}
