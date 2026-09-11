// One handler per ClientMsg kind, exhaustive by type: adding a message without a handler is a
// compile error. Handlers marshal (pick fields, shape replies) and call a service; they do not
// run git or decide policy.

import type { ClientMsg, ServerMsg, WorktreeInfo } from "@toyon/shared";
import { pickTheme, SHELL_STREAM } from "@toyon/shared";
import type { AgentAccounts } from "../agent/accounts.ts";
import type { AttachmentStore } from "../agent/attachments.ts";
import { agentConfigFiles, describeAgentConfig } from "../agent/config.ts";
import type { AgentRegistry } from "../agent/registry.ts";
import { UserError } from "../core/errors.ts";
import type { Hub } from "../core/hub.ts";
import { fireAndForget, log } from "../core/log.ts";
import type { StateStore } from "../core/state.ts";
import type { DesignService } from "../design/service.ts";
import type { ExecService } from "../exec/service.ts";
import type { FileService } from "../files/service.ts";
import { browsePath } from "../repos/browse.ts";
import type { RepoRegistry } from "../repos/registry.ts";
import type { RouteService } from "../routes/service.ts";
import type { RuntimeRegistry } from "../runtime/registry.ts";
import type { ThemeStore } from "../themes/store.ts";
import type { RefSearch } from "../worktrees/refs.ts";
import type { WorktreeService } from "../worktrees/service.ts";

export interface Services {
  state: StateStore;
  hub: Hub;
  repos: RepoRegistry;
  worktrees: WorktreeService;
  files: FileService;
  /** the worktree's own design system, scanned from its source */
  design: DesignService;
  /** the route bar's list: which preview pages each repo is used on */
  routes: RouteService;
  runtime: RuntimeRegistry;
  /** one-off commands from the composer's `!` mode */
  exec: ExecService;
  /** the ref palette: branches and PRs a worktree could be opened on */
  refs: RefSearch;
  themes: ThemeStore;
  agents: AgentRegistry;
  /** per-agent login state, and the one write on it (sign out) */
  accounts: AgentAccounts;
  /** images attached to chat messages; the http layer serves them back to the shell */
  attachments: AttachmentStore;
  /** request → 1–5 independent tasks (the default agent by default; tests inject a stub) */
  planTasks: (prompt: string, cwd: string) => Promise<string[] | null>;
}

export interface HandlerCtx {
  /** to the socket that sent the message */
  reply(msg: ServerMsg): void;
  /** to every connected socket */
  broadcast(msg: ServerMsg): void;
  /** this socket wants a worktree's stream; false if it already had it */
  subscribe(worktreeId: string): boolean;
  unsubscribe(worktreeId: string): void;
  /** this socket has that stream's tab open: it gets its term-data / term-exit */
  watchTerminal(worktreeId: string, stream: string): void;
  unwatchTerminal(worktreeId: string, stream: string): void;
}

type Handler<K extends ClientMsg["t"]> = (
  msg: Extract<ClientMsg, { t: K }>,
  ctx: HandlerCtx,
  s: Services,
) => Promise<void> | void;

const toast = (
  worktreeId: string,
  ok: boolean,
  message: string,
  extra: Partial<Extract<ServerMsg, { t: "shipped" }>> = {},
) => ({ t: "shipped", worktreeId, ok, message, ...extra }) satisfies ServerMsg;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const gitStatus = async (s: Services, ctx: HandlerCtx, worktreeId: string) => {
  const info = await s.worktrees.gitStatus(worktreeId);
  if (info) ctx.reply({ t: "git-status", worktreeId, ...info });
};

/** the landing-op tail: tell the caller what happened, then refresh its changes panel */
const notify = async (s: Services, ctx: HandlerCtx, worktreeId: string, msg: ServerMsg) => {
  ctx.reply(msg);
  await gitStatus(s, ctx, worktreeId);
};

/** The agent actions want a worktree toyon runs. One it merely found in git has a row and a pane
 * like the others, so the refusal names the way out rather than calling the worktree unknown. */
const requireRun = (s: Services, id: string): WorktreeInfo => {
  if (!s.state.worktree(id) && s.worktrees.readable(id)) {
    throw new UserError("toyon does not run this worktree: take it over first");
  }
  return s.state.requireWorktree(id);
};

export const handlers: { [K in ClientMsg["t"]]: Handler<K> } = {
  async subscribe(msg, ctx, s) {
    const r = s.worktrees.readable(msg.worktreeId);
    if (!r) throw new UserError("unknown worktree");
    // the shell re-asserts its whole subscription set on every switch; only a NEW subscription
    // needs the backfill (an existing one has been receiving the stream all along)
    if (!ctx.subscribe(msg.worktreeId)) return;
    // a worktree toyon merely knows about has no transcript, no queue and nothing to start: the
    // stream it gets is git status, which is what the changes panel and the rail badges read
    if (!r.wt) {
      ctx.reply({ t: "backfill", worktreeId: msg.worktreeId, events: [], log: [] });
      ctx.reply({ t: "queue", worktreeId: msg.worktreeId, items: [] });
      ctx.reply({ t: "agent-commands", worktreeId: msg.worktreeId, commands: [] });
      await gitStatus(s, ctx, msg.worktreeId);
      return;
    }
    // opening is what starts a cold worktree; the reply does not wait for it
    s.repos.touch(msg.worktreeId);
    // the adapter, not the runtime: a cold worktree has its transcript on disk and nothing else
    const agent = s.runtime.ensureAgent(r.wt).agent;
    const events = agent.transcript();
    ctx.reply({
      t: "backfill",
      worktreeId: msg.worktreeId,
      events: events.slice(-1000),
      log: s.runtime.recentLogs(msg.worktreeId),
    });
    ctx.reply({ t: "queue", worktreeId: msg.worktreeId, items: agent.queueItems });
    ctx.reply({ t: "agent-commands", worktreeId: msg.worktreeId, commands: agent.commands });
    await gitStatus(s, ctx, msg.worktreeId);
  },

  unsubscribe(msg, ctx) {
    ctx.unsubscribe(msg.worktreeId);
  },

  seen(msg, _ctx, s) {
    s.worktrees.markSeen(msg.worktreeId);
  },

  visit(msg, _ctx, s) {
    s.routes.visit(msg.worktreeId, msg.path);
  },

  "forget-visit"(msg, _ctx, s) {
    s.routes.forget(msg.repoId, msg.path);
  },

  async routes(msg, ctx, s) {
    ctx.reply({ t: "routes", worktreeId: msg.worktreeId, routes: await s.routes.files(msg.worktreeId) });
  },

  chat(msg, _ctx, s) {
    requireRun(s, msg.worktreeId);
    const agent = s.runtime.agentFor(msg.worktreeId);
    if (!agent) throw new UserError("worktree still starting; try again in a moment");
    agent.send(msg.text, { context: msg.context, pick: msg.pick, images: msg.images, pastes: msg.pastes });
    s.hub.emit("worktreesChanged"); // queued-count may have changed
  },

  async "create-worktree"(msg, _ctx, s) {
    await s.worktrees.create(msg.repoId, msg.prompt, {
      createdBy: msg.clientId,
      baseWorktreeId: msg.baseWorktreeId,
      variant: msg.variant,
      context: msg.context,
      pick: msg.pick,
      images: msg.images,
      pastes: msg.pastes,
      agent: msg.agent,
      profile: msg.profile,
      mode: msg.mode,
      model: msg.model,
      effort: msg.effort,
    });
  },

  "set-worktree-profile"(msg, _ctx, s) {
    s.worktrees.setProfile(msg.worktreeId, msg.profile);
  },

  "set-worktree-mode"(msg, _ctx, s) {
    s.worktrees.setMode(msg.worktreeId, msg.mode);
  },

  "set-worktree-model"(msg, _ctx, s) {
    s.worktrees.setModel(msg.worktreeId, msg.model);
  },

  "set-worktree-effort"(msg, _ctx, s) {
    s.worktrees.setEffort(msg.worktreeId, msg.effort);
  },

  "batch-worktrees"(msg, ctx, s) {
    const repo = s.state.requireRepo(msg.repoId);
    ctx.reply(toast("", true, "batch: planning tasks…"));
    // plan + spawn in the background so the socket stays responsive. The final reply may land on
    // a socket that has since closed; reply() tolerates that.
    fireAndForget(
      msg.repoId,
      (async () => {
        const tasks = (await s.planTasks(msg.prompt, repo.path)) ?? [msg.prompt];
        let failed = 0;
        for (const task of tasks) {
          try {
            await s.worktrees.create(msg.repoId, task, { agent: msg.agent, model: msg.model, effort: msg.effort });
          } catch (e) {
            failed++;
            log.warn(msg.repoId, `batch: could not start "${task.slice(0, 60)}"`, e);
          }
        }
        const started = tasks.length - failed;
        ctx.reply(
          toast(
            "",
            failed === 0,
            failed
              ? `batch: ${started} started, ${failed} failed (see daemon log)`
              : `batch: ${started} worktree(s) started`,
          ),
        );
      })(),
      "batch",
    );
  },

  async "remove-worktree"(msg, _ctx, s) {
    await s.worktrees.remove(msg.worktreeId);
  },

  async "adopt-worktree"(msg, _ctx, s) {
    await s.worktrees.adopt(msg.worktreeId, msg.clientId);
  },

  async "git-status"(msg, ctx, s) {
    await gitStatus(s, ctx, msg.worktreeId);
  },

  async "read-file"(msg, ctx, s) {
    const head = { t: "file-read", worktreeId: msg.worktreeId, path: msg.path, ref: msg.ref, seq: msg.seq } as const;
    try {
      ctx.reply({ ...head, ...(await s.files.read(msg.worktreeId, msg.path, msg.ref)) });
    } catch (e) {
      // answered either way: the shell holds one request per open file until this comes back
      if (!(e instanceof UserError)) log.error(msg.worktreeId, "read-file failed", e);
      const nothing = { before: "", after: "", version: null, writable: false, binary: false, tooLarge: false };
      ctx.reply({ ...head, ...nothing, error: errorText(e) });
    }
  },

  async "git-log"(msg, ctx, s) {
    const commits = await s.worktrees.gitLog(msg.worktreeId);
    ctx.reply({ t: "git-log", worktreeId: msg.worktreeId, commits });
  },

  async "git-commit"(msg, ctx, s) {
    const files = await s.worktrees.commitFiles(msg.worktreeId, msg.sha);
    ctx.reply({ t: "git-commit", worktreeId: msg.worktreeId, sha: msg.sha, files });
  },

  async ship(msg, ctx, s) {
    const result = await s.worktrees.ship(msg.worktreeId);
    await notify(s, ctx, msg.worktreeId, toast(msg.worktreeId, result.ok, result.message, { url: result.url }));
  },

  async "merge-main"(msg, ctx, s) {
    const { result, removeIds } = await s.worktrees.merge(msg.worktreeId);
    await notify(
      s,
      ctx,
      msg.worktreeId,
      toast(msg.worktreeId, result.ok, result.message, { merged: result.ok, removeIds }),
    );
  },

  async "sync-main"(msg, ctx, s) {
    const { result, defaultBranch } = await s.worktrees.sync(msg.worktreeId);
    // a prefilled prompt is for a conflict, and only where there is an agent to prompt: a dirty
    // tree is a plain refusal, and a found worktree has no composer for the suggestion to land in
    const prompt = !result.ok && result.conflict && s.state.worktree(msg.worktreeId);
    await notify(
      s,
      ctx,
      msg.worktreeId,
      prompt
        ? toast(msg.worktreeId, false, `sync conflicts with ${defaultBranch}: prompt prefilled in chat`, {
            suggestion: `Merge ${defaultBranch} into this branch and resolve the conflicts, then verify the app still works.`,
          })
        : toast(msg.worktreeId, result.ok, result.message),
    );
  },

  async "pull-main"(msg, ctx, s) {
    const result = await s.worktrees.pull(msg.worktreeId);
    await notify(s, ctx, msg.worktreeId, toast(msg.worktreeId, result.ok, result.message));
  },

  async commit(msg, ctx, s) {
    const result = await s.worktrees.commit(msg.worktreeId, msg.message);
    await notify(s, ctx, msg.worktreeId, toast(msg.worktreeId, result.ok, result.message));
  },

  async graft(msg, ctx, s) {
    const { target, grafted } = await s.worktrees.graft(msg.targetId, msg.sourceIds);
    await notify(
      s,
      ctx,
      target.id,
      toast(target.id, true, `grafted ${grafted.join(", ")} into ${target.title}; merged locally, nothing pushed`),
    );
  },

  async "rename-worktree"(msg, _ctx, s) {
    await s.worktrees.rename(msg.worktreeId, msg.title);
  },

  "list-commands"(msg, _ctx, s) {
    requireRun(s, msg.worktreeId);
    const agent = s.runtime.agentFor(msg.worktreeId);
    // best effort and slow (it spawns the adapter): the reply, if any, is the agent-commands push
    if (agent) fireAndForget(msg.worktreeId, agent.warmCommands(), "warm commands");
  },

  async "list-files"(msg, ctx, s) {
    ctx.reply({ t: "files", worktreeId: msg.worktreeId, paths: await s.files.list(msg.worktreeId) });
  },

  async search(msg, ctx, s) {
    const { hits, truncated } = await s.files.search(msg.worktreeId, msg.query);
    ctx.reply({ t: "search-results", worktreeId: msg.worktreeId, query: msg.query, hits, truncated });
  },

  async "design-scan"(msg, ctx, s) {
    const index = await s.design.scan(msg.worktreeId);
    ctx.reply({ t: "design-index", worktreeId: msg.worktreeId, index });
  },

  "stop-agent"(msg, _ctx, s) {
    requireRun(s, msg.worktreeId);
    s.runtime.agentFor(msg.worktreeId)?.stop();
  },

  async "pick-variant"(msg, _ctx, s) {
    await s.worktrees.pickVariant(msg.worktreeId);
  },

  unqueue(msg, _ctx, s) {
    requireRun(s, msg.worktreeId);
    s.runtime.agentFor(msg.worktreeId)?.unqueue(msg.index);
  },

  async "changed-ranges"(msg, ctx, s) {
    const { ranges, lineOffset } = await s.files.changedRanges(msg.worktreeId, msg.path);
    ctx.reply({ t: "changed-ranges", worktreeId: msg.worktreeId, path: msg.path, ranges, lineOffset });
  },

  reveal(msg, _ctx, s) {
    s.files.reveal(msg.worktreeId, msg.path);
  },

  async "discard-file"(msg, ctx, s) {
    await s.files.discard(msg.worktreeId, msg.path);
    ctx.reply(toast(msg.worktreeId, true, `discarded ${msg.path}`));
    // every tab's changes list re-reads from the git-status this pushes, and an editor open on the
    // file re-reads the file from that
    s.hub.emit("filesChanged", msg.worktreeId);
  },

  async "write-file"(msg, ctx, s) {
    const head = { t: "file-written", worktreeId: msg.worktreeId, path: msg.path, seq: msg.seq } as const;
    try {
      const written = await s.files.write(msg.worktreeId, msg.path, msg.content, msg.base);
      ctx.reply({ ...head, ...written });
      // no toast: autosave fires constantly; the changes list is the feedback, on every tab
      if (written.ok) s.hub.emit("filesChanged", msg.worktreeId);
    } catch (e) {
      // answered either way, as a read is: an unanswered write would hold the file's next save forever
      if (!(e instanceof UserError)) log.error(msg.worktreeId, "write-file failed", e);
      ctx.reply({ ...head, ok: false, reason: "refused", version: null, message: errorText(e) });
    }
  },

  "confirm-config"(msg, _ctx, s) {
    s.repos.confirmConfig(msg.repoId, msg.config);
  },

  async "register-repo"(msg, ctx, s) {
    const repo = await s.repos.register(msg.path);
    ctx.reply(toast("", true, `opened ${repo.name}`));
  },

  async "create-repo"(msg, ctx, s) {
    // A clone runs long enough that it becomes a thing the daemon holds and the shell watches,
    // rather than a promise this socket waits on: startImport validates and returns at once, and
    // the import pane is the feedback from there. A create is fast, so it stays a plain await.
    if (msg.mode === "clone") {
      s.repos.startImport({ parent: msg.parent, name: msg.name, url: msg.url ?? "" });
      return;
    }
    const repo = await s.repos.create(msg);
    ctx.reply(toast("", true, `created ${repo.name}`));
  },

  "cancel-import"(msg, _ctx, s) {
    s.repos.cancelImport(msg.id);
  },

  async "browse-path"(msg, ctx, _s) {
    ctx.reply({ t: "path-entries", query: msg.path, ...(await browsePath(msg.path)) });
  },

  async "forget-repo"(msg, ctx, s) {
    const name = s.state.requireRepo(msg.repoId).name;
    await s.repos.forget(msg.repoId);
    ctx.reply(toast("", true, `forgot ${name}`));
  },

  "set-theme"(msg, _ctx, s) {
    s.themes.setPrefs(msg.prefs);
    s.hub.emit("themesChanged");
  },

  "import-theme"(msg, _ctx, s) {
    const theme = s.themes.import(msg.name, msg.source);
    s.themes.setPrefs(pickTheme(s.themes.prefs, theme, s.themes.themes));
    s.hub.emit("themesChanged");
  },

  "install-agent"(msg, _ctx, s) {
    if (!s.agents.get(msg.agent)) throw new UserError(`unknown agent "${msg.agent}"`);
    fireAndForget(msg.agent, s.agents.install(msg.agent), "agent install");
  },

  async "agent-auth"(msg, _ctx, s) {
    requireRun(s, msg.worktreeId);
    const agent = s.runtime.agentFor(msg.worktreeId);
    if (!agent) throw new UserError("worktree still starting; try again in a moment");
    const r = await agent.authenticate(msg.methodId, msg.apiKey);
    if (r.kind === "terminal") s.runtime.terminalLine(msg.worktreeId, r.line);
  },

  "agent-retry"(msg, _ctx, s) {
    requireRun(s, msg.worktreeId);
    s.runtime.agentFor(msg.worktreeId)?.retry();
  },

  // No UserError when the ask has already closed: two shells can watch one worktree, and the
  // loser of that race would get a toast about a card that is about to disappear anyway.
  "agent-answer"(msg, _ctx, s) {
    requireRun(s, msg.worktreeId);
    s.runtime.agentFor(msg.worktreeId)?.answer(msg.askId, { kind: "answers", answers: msg.answers });
  },

  "agent-decide"(msg, _ctx, s) {
    requireRun(s, msg.worktreeId);
    s.runtime.agentFor(msg.worktreeId)?.answer(msg.askId, { kind: "choice", choiceId: msg.choiceId });
  },

  "agent-config"(msg, ctx, s) {
    const spec = s.agents.require(msg.agent);
    const repoPath = msg.repoId ? (s.state.repo(msg.repoId)?.path ?? null) : null;
    ctx.reply({ t: "agent-config", ...describeAgentConfig(spec, repoPath) });
  },

  "reveal-agent-file"(msg, _ctx, s) {
    // only a path the listing named: the shell echoes an id, never a path of its own
    const spec = s.agents.require(msg.agent);
    const repoPath = msg.repoId ? (s.state.repo(msg.repoId)?.path ?? null) : null;
    const file = agentConfigFiles(spec, repoPath).find((f) => f.id === msg.file);
    if (!file) throw new UserError("no such file");
    s.files.revealPath(file.path);
  },

  async "agent-logout"(msg, _ctx, s) {
    await s.accounts.logout(msg.agent);
    s.hub.emit("agentsChanged");
  },

  "set-default-agent"(msg, _ctx, s) {
    s.agents.require(msg.agent);
    s.state.setDefaultAgent(msg.agent);
    s.hub.emit("agentsChanged");
  },

  "rescan-themes"(_msg, _ctx, s) {
    s.themes.load();
    s.hub.emit("themesChanged");
  },

  "term-open"(msg, ctx, s) {
    // open, watch and reply in one synchronous block: pty output only arrives on later ticks, so
    // nothing the stream prints can fall between the snapshot and the watch
    const loose = looseCwd(s, msg.worktreeId, msg.stream);
    const { snapshot, alive } = loose
      ? s.runtime.openLooseShell(msg.worktreeId, loose, msg.cols, msg.rows)
      : s.runtime.openTerminal(msg.worktreeId, msg.stream, msg.cols, msg.rows);
    ctx.watchTerminal(msg.worktreeId, msg.stream);
    ctx.reply({ t: "term-snapshot", worktreeId: msg.worktreeId, stream: msg.stream, data: snapshot, alive });
  },

  "term-input"(msg, _ctx, s) {
    const loose = s.runtime.looseShell(msg.worktreeId);
    if (loose) loose.write(msg.data);
    else s.runtime.terminalInput(msg.worktreeId, msg.stream, msg.data);
  },

  "term-resize"(msg, _ctx, s) {
    const loose = s.runtime.looseShell(msg.worktreeId);
    if (loose) loose.resize(msg.cols, msg.rows);
    else s.runtime.terminalResize(msg.worktreeId, msg.stream, msg.cols, msg.rows);
  },

  "term-restart"(msg, _ctx, s) {
    // a loose shell restarts by dying: the next term-open respawns it, same as a worktree's own
    const loose = s.runtime.looseShell(msg.worktreeId);
    if (loose) {
      fireAndForget("term-restart", Promise.resolve(loose.kill()));
      return;
    }
    requireRun(s, msg.worktreeId);
    // the tab reopens on its own once the stream is gone; nothing waits on the restart
    fireAndForget("term-restart", s.runtime.restartStream(msg.worktreeId, msg.stream));
  },

  "term-close"(msg, ctx) {
    ctx.unwatchTerminal(msg.worktreeId, msg.stream);
  },

  exec(msg, _ctx, s) {
    s.exec.run(msg.worktreeId, msg.command);
  },

  "exec-stop"(msg, _ctx, s) {
    requireRun(s, msg.worktreeId);
    s.exec.stop(msg.worktreeId);
  },

  async "search-refs"(msg, ctx, s) {
    const refs = await s.refs.search(msg.repoId, msg.query);
    ctx.reply({ t: "refs", repoId: msg.repoId, query: msg.query, refs });
  },

  async "open-ref"(msg, _ctx, s) {
    await s.worktrees.openRef(msg.repoId, msg.kind, msg.ref, { createdBy: msg.clientId, pr: msg.pr });
  },
};

/** The directory a loose shell should open in, or null when this id is an ordinary worktree.
 * A discovered worktree runs nothing, so its only stream is a shell: asking for a proc's stream on
 * one is a bug in the caller, not a tab to open. */
function looseCwd(s: Services, id: string, stream: string): string | null {
  const disc = s.worktrees.discoveredById(id);
  if (!disc) return null;
  if (stream !== SHELL_STREAM) throw new UserError(`${disc.name} runs no processes: only a shell`);
  return disc.path;
}

/** dispatch one validated message */
export async function dispatch(msg: ClientMsg, ctx: HandlerCtx, s: Services): Promise<void> {
  const h = handlers[msg.t] as Handler<typeof msg.t>;
  await h(msg, ctx, s);
}
