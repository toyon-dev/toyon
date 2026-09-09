// One handler per ClientMsg kind, exhaustive by type: adding a message without a handler is a
// compile error. Handlers marshal (pick fields, shape replies) and call a service; they do not
// run git or decide policy.

import type { ClientMsg, ServerMsg } from "@toyon/shared";
import { pickTheme } from "@toyon/shared";
import type { AgentAccounts } from "../agent/accounts.ts";
import type { AttachmentStore } from "../agent/attachments.ts";
import type { AgentRegistry } from "../agent/registry.ts";
import { UserError } from "../core/errors.ts";
import type { Hub } from "../core/hub.ts";
import { fireAndForget, log } from "../core/log.ts";
import type { StateStore } from "../core/state.ts";
import type { DesignService } from "../design/service.ts";
import type { FileService } from "../files/service.ts";
import { browsePath } from "../repos/browse.ts";
import type { RepoRegistry } from "../repos/registry.ts";
import type { RuntimeRegistry } from "../runtime/registry.ts";
import type { ThemeStore } from "../themes/store.ts";
import type { WorktreeService } from "../worktrees/service.ts";

export interface Services {
  state: StateStore;
  hub: Hub;
  repos: RepoRegistry;
  worktrees: WorktreeService;
  files: FileService;
  /** the worktree's own design system, scanned from its source */
  design: DesignService;
  runtime: RuntimeRegistry;
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

const gitStatus = async (s: Services, ctx: HandlerCtx, worktreeId: string) => {
  const info = await s.worktrees.gitStatus(worktreeId);
  if (info) ctx.reply({ t: "git-status", worktreeId, ...info });
};

/** the landing-op tail: tell the caller what happened, then refresh its changes panel */
const notify = async (s: Services, ctx: HandlerCtx, worktreeId: string, msg: ServerMsg) => {
  ctx.reply(msg);
  await gitStatus(s, ctx, worktreeId);
};

export const handlers: { [K in ClientMsg["t"]]: Handler<K> } = {
  async subscribe(msg, ctx, s) {
    s.state.requireWorktree(msg.worktreeId);
    // the shell re-asserts its whole subscription set on every switch; only a NEW subscription
    // needs the backfill (an existing one has been receiving the stream all along)
    if (!ctx.subscribe(msg.worktreeId)) return;
    const agent = s.runtime.agentFor(msg.worktreeId);
    const events = agent?.transcript() ?? [];
    ctx.reply({
      t: "backfill",
      worktreeId: msg.worktreeId,
      events: events.slice(-1000),
      log: s.runtime.recentLogs(msg.worktreeId),
    });
    ctx.reply({ t: "queue", worktreeId: msg.worktreeId, items: agent?.queueItems ?? [] });
    ctx.reply({ t: "agent-commands", worktreeId: msg.worktreeId, commands: agent?.commands ?? [] });
    await gitStatus(s, ctx, msg.worktreeId);
  },

  unsubscribe(msg, ctx) {
    ctx.unsubscribe(msg.worktreeId);
  },

  seen(msg, _ctx, s) {
    s.worktrees.markSeen(msg.worktreeId);
  },

  chat(msg, _ctx, s) {
    s.state.requireWorktree(msg.worktreeId);
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
      agent: msg.agent,
      profile: msg.profile,
    });
  },

  "set-worktree-profile"(msg, _ctx, s) {
    s.worktrees.setProfile(msg.worktreeId, msg.profile);
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
            await s.worktrees.create(msg.repoId, task, { agent: msg.agent });
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

  async "git-status"(msg, ctx, s) {
    await gitStatus(s, ctx, msg.worktreeId);
  },

  async "file-diff"(msg, ctx, s) {
    const { before, after } = await s.files.diff(msg.worktreeId, msg.path);
    ctx.reply({ t: "file-diff", worktreeId: msg.worktreeId, path: msg.path, before, after });
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
    await notify(
      s,
      ctx,
      msg.worktreeId,
      result.ok
        ? toast(msg.worktreeId, true, result.message)
        : toast(msg.worktreeId, false, `sync conflicts with ${defaultBranch}: prompt prefilled in chat`, {
            suggestion: `Merge ${defaultBranch} into this branch and resolve the conflicts, then verify the app still works.`,
          }),
    );
  },

  async commit(msg, ctx, s) {
    const result = await s.worktrees.commit(msg.worktreeId, msg.message);
    await notify(s, ctx, msg.worktreeId, toast(msg.worktreeId, result.ok, result.message));
  },

  async combine(msg, ctx, s) {
    const wt = await s.worktrees.combine(msg.worktreeIds);
    ctx.reply(
      toast(wt.id, true, `grafted: ${wt.title}; local merge of ${msg.worktreeIds.length} branches, nothing pushed`),
    );
  },

  async "rename-worktree"(msg, _ctx, s) {
    await s.worktrees.rename(msg.worktreeId, msg.title);
  },

  "list-commands"(msg, _ctx, s) {
    s.state.requireWorktree(msg.worktreeId);
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
    s.state.requireWorktree(msg.worktreeId);
    s.runtime.agentFor(msg.worktreeId)?.stop();
  },

  async "pick-variant"(msg, _ctx, s) {
    await s.worktrees.pickVariant(msg.worktreeId);
  },

  unqueue(msg, _ctx, s) {
    s.state.requireWorktree(msg.worktreeId);
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
    await notify(s, ctx, msg.worktreeId, toast(msg.worktreeId, true, `discarded ${msg.path}`));
  },

  async "write-file"(msg, ctx, s) {
    await s.files.write(msg.worktreeId, msg.path, msg.content);
    // no toast: autosave fires constantly; the changes list is the feedback
    await gitStatus(s, ctx, msg.worktreeId);
  },

  "confirm-config"(msg, _ctx, s) {
    s.repos.confirmConfig(msg.repoId, msg.config);
  },

  async "register-repo"(msg, ctx, s) {
    const repo = await s.repos.register(msg.path);
    ctx.reply(toast("", true, `opened ${repo.name}`));
  },

  async "create-repo"(msg, ctx, s) {
    // A clone is network bound and can run for minutes, so awaiting it would stall this socket's
    // message loop. It reports twice instead, the way batch-worktrees does. fireAndForget would
    // turn a failure into a log line nobody sees, leaving the shell saying "cloning" forever, so
    // the rejection is caught and toasted here rather than left to the UserError path.
    if (msg.mode === "clone") {
      ctx.reply(toast("", true, `cloning ${msg.name}…`));
      fireAndForget(
        msg.name,
        s.repos
          .create(msg)
          .then((repo) => ctx.reply(toast("", true, `cloned ${repo.name}`)))
          .catch((e: unknown) => {
            ctx.reply(toast("", false, e instanceof Error ? e.message : String(e)));
            throw e; // rethrown so a non-UserError still reaches the daemon log as a bug
          }),
        "clone",
      );
      return;
    }
    const repo = await s.repos.create(msg);
    ctx.reply(toast("", true, `created ${repo.name}`));
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
    s.state.requireWorktree(msg.worktreeId);
    const agent = s.runtime.agentFor(msg.worktreeId);
    if (!agent) throw new UserError("worktree still starting; try again in a moment");
    const r = await agent.authenticate(msg.methodId, msg.apiKey);
    if (r.kind === "terminal") s.runtime.terminalLine(msg.worktreeId, r.line);
  },

  "agent-retry"(msg, _ctx, s) {
    s.state.requireWorktree(msg.worktreeId);
    s.runtime.agentFor(msg.worktreeId)?.retry();
  },

  // No UserError when the ask has already closed: two shells can watch one worktree, and the
  // loser of that race would get a toast about a card that is about to disappear anyway.
  "agent-answer"(msg, _ctx, s) {
    s.state.requireWorktree(msg.worktreeId);
    s.runtime.agentFor(msg.worktreeId)?.answer(msg.askId, { kind: "answers", answers: msg.answers });
  },

  "agent-decide"(msg, _ctx, s) {
    s.state.requireWorktree(msg.worktreeId);
    s.runtime.agentFor(msg.worktreeId)?.answer(msg.askId, { kind: "choice", choiceId: msg.choiceId });
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
    const { snapshot, alive } = s.runtime.openTerminal(msg.worktreeId, msg.stream, msg.cols, msg.rows);
    ctx.watchTerminal(msg.worktreeId, msg.stream);
    ctx.reply({ t: "term-snapshot", worktreeId: msg.worktreeId, stream: msg.stream, data: snapshot, alive });
  },

  "term-input"(msg, _ctx, s) {
    s.runtime.terminalInput(msg.worktreeId, msg.stream, msg.data);
  },

  "term-resize"(msg, _ctx, s) {
    s.runtime.terminalResize(msg.worktreeId, msg.stream, msg.cols, msg.rows);
  },

  "term-restart"(msg, _ctx, s) {
    s.state.requireWorktree(msg.worktreeId);
    // the tab reopens on its own once the stream is gone; nothing waits on the restart
    fireAndForget("term-restart", s.runtime.restartStream(msg.worktreeId, msg.stream));
  },

  "term-close"(msg, ctx) {
    ctx.unwatchTerminal(msg.worktreeId, msg.stream);
  },
};

/** dispatch one validated message */
export async function dispatch(msg: ClientMsg, ctx: HandlerCtx, s: Services): Promise<void> {
  const h = handlers[msg.t] as Handler<typeof msg.t>;
  await h(msg, ctx, s);
}
