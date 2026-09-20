// One handler per ClientMsg kind, exhaustive by type: adding a message without a handler is a
// compile error. Handlers marshal (pick fields, shape replies) and call a service; they do not
// run git or decide policy.

import type { ClientMsg, ServerMsg, WorktreeInfo } from "@toyon/shared";
import { isLead, pickTheme, SHELL_STREAM } from "@toyon/shared";
import type { AgentAccounts } from "../agent/accounts.ts";
import type { AttachmentStore } from "../agent/attachments.ts";
import { agentConfigFiles, describeAgentConfig } from "../agent/config.ts";
import type { AgentRegistry } from "../agent/registry.ts";
import { coalesce } from "../agent/transcript.ts";
import type { FolderDialog } from "../core/dialog.ts";
import { UserError } from "../core/errors.ts";
import type { Hub } from "../core/hub.ts";
import { fireAndForget, log } from "../core/log.ts";
import type { Restarter } from "../core/restarter.ts";
import type { SelfWatch } from "../core/self.ts";
import type { StateStore } from "../core/state.ts";
import type { DesignService } from "../design/service.ts";
import type { DraftStore } from "../drafts/store.ts";
import type { ExecService } from "../exec/service.ts";
import { type FileService, keptRead } from "../files/service.ts";
import type { AfterLand } from "../repos/afterLand.ts";
import { browsePath, describeFolder } from "../repos/browse.ts";
import type { RepoRegistry } from "../repos/registry.ts";
import type { RouteService } from "../routes/service.ts";
import type { IdlePolicy } from "../runtime/idle.ts";
import { DEFAULT_AGENT_ID, type RuntimeRegistry } from "../runtime/registry.ts";
import { daylightNow } from "../themes/daylight.ts";
import type { ThemeStore } from "../themes/store.ts";
import type { UpdateService } from "../update/service.ts";
import type { ChatSearch } from "../worktrees/chats.ts";
import type { PrService } from "../worktrees/prs.ts";
import type { RefSearch } from "../worktrees/refs.ts";
import type { WorktreeService } from "../worktrees/service.ts";
import type { TurnService } from "../worktrees/turns.ts";

export interface Services {
  state: StateStore;
  hub: Hub;
  repos: RepoRegistry;
  worktrees: WorktreeService;
  /** how each worktree's agent last stopped, and whether anyone has looked since */
  turns: TurnService;
  files: FileService;
  /** the worktree's own design system, scanned from its source */
  design: DesignService;
  /** the route bar's list: which preview pages each repo is used on */
  routes: RouteService;
  runtime: RuntimeRegistry;
  /** which worktrees run: the ones tabs show, and what a turn or a command holds */
  idle: IdlePolicy;
  /** one-off commands from the composer's `!` mode */
  exec: ExecService;
  /** the ref palette: branches and PRs a worktree could be opened on */
  refs: RefSearch;
  /** the chats palette: what a project's chats say, live worktrees and archived ones */
  chats: ChatSearch;
  /** the unsent text in every composer box */
  drafts: DraftStore;
  /** what GitHub says about the PRs toyon opened */
  prs: PrService;
  themes: ThemeStore;
  agents: AgentRegistry;
  /** per-agent login state, and the one write on it (sign out) */
  accounts: AgentAccounts;
  /** images attached to chat messages; the http layer serves them back to the shell */
  attachments: AttachmentStore;
  /** whether the checkout this daemon runs from has moved on without it */
  self: SelfWatch;
  /** the repo's catch-up commands, so the notice above can offer to run them */
  afterLand: AfterLand;
  /** a restart someone asked for, held until no chat is mid-reply */
  restarter: Restarter;
  /** whether the Toyon installed is the one running */
  update: UpdateService;
  /** request → 1–5 independent tasks, asked of the agent that will run them (tests inject a stub) */
  planTasks: (prompt: string, cwd: string, agentId: string) => Promise<string[] | null>;
  /** the OS folder dialog behind the new-project form's folder button (tests inject a stub) */
  folderDialog: FolderDialog;
}

export interface HandlerCtx {
  /** to the socket that sent the message */
  reply(msg: ServerMsg): void;
  /** to every connected socket */
  broadcast(msg: ServerMsg): void;
  /** this socket wants a worktree's stream; false if it already had it */
  subscribe(worktreeId: string): boolean;
  unsubscribe(worktreeId: string): void;
  /** this socket's tab shows that worktree now, or none: what keeps its dev servers running */
  view(worktreeId: string | null): void;
  /** this socket has that stream's tab open: it gets its term-data / term-exit */
  watchTerminal(worktreeId: string, stream: string): void;
  unwatchTerminal(worktreeId: string, stream: string): void;
}

type Handler<K extends ClientMsg["t"]> = (
  msg: Extract<ClientMsg, { t: K }>,
  ctx: HandlerCtx,
  s: Services,
) => Promise<void> | void;

type Shipped = Extract<ServerMsg, { t: "shipped" }>;

/** the word on a landing op. The shell reads a failure on the worktree's chat and a merge as a row
 * there; a success with nothing to offer it says nothing about, since the panel and the row show
 * it. So only ops whose outcome is worth a line send one. */
const shipped = (worktreeId: string, ok: boolean, message: string, extra: Partial<Shipped> = {}) =>
  ({ t: "shipped", worktreeId, ok, message, ...extra }) satisfies ServerMsg;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const gitStatus = async (s: Services, ctx: HandlerCtx, worktreeId: string) => {
  const info = await s.worktrees.gitStatus(worktreeId);
  if (info) ctx.reply({ t: "git-status", worktreeId, ...info });
  return info;
};

/** what a subscriber is sent after its backfill: the changes list, then the pages the worktree's
 * files define with their badges, so the route list is ready before anyone opens it */
const gitAndPages = async (s: Services, ctx: HandlerCtx, worktreeId: string) => {
  const info = await gitStatus(s, ctx, worktreeId);
  ctx.reply({ t: "routes", worktreeId, ...(await s.routes.pages(worktreeId, info ?? { files: [] })) });
};

/** the landing-op tail: tell the caller what happened, then refresh its changes panel. A failure
 * also rings the worktree's row: the reason waits on its chat, and the person may have moved on
 * while the op ran. */
const notify = async (s: Services, ctx: HandlerCtx, worktreeId: string, msg: Shipped) => {
  ctx.reply(msg);
  if (!msg.ok) s.turns.markUnread(worktreeId);
  await gitStatus(s, ctx, worktreeId);
};

const requireRun = (s: Services, id: string): WorktreeInfo => s.worktrees.requireRun(id);

export const handlers: { [K in ClientMsg["t"]]: Handler<K> } = {
  async subscribe(msg, ctx, s) {
    const r = s.worktrees.readable(msg.worktreeId);
    if (!r) {
      // an archived worktree: its chat as it was, read in place. Nothing runs and nothing is on
      // disk to have a status, so the transcript is the whole stream; the subscription is under
      // the same id the worktree comes back with, so a restore's events reach this socket
      const kept = s.worktrees.archivedTranscript(msg.worktreeId);
      if (!kept) throw new UserError("unknown worktree");
      if (!ctx.subscribe(msg.worktreeId)) return;
      ctx.reply({ t: "backfill", worktreeId: msg.worktreeId, events: coalesce(kept), log: [] });
      ctx.reply({ t: "queue", worktreeId: msg.worktreeId, items: [] });
      ctx.reply({ t: "agent-commands", worktreeId: msg.worktreeId, commands: [] });
      // and what it left in git, which the changes panel on its page reads
      await gitStatus(s, ctx, msg.worktreeId);
      return;
    }
    // the shell re-asserts its whole subscription set on every switch; only a NEW subscription
    // needs the backfill (an existing one has been receiving the stream all along)
    if (!ctx.subscribe(msg.worktreeId)) return;
    // a worktree toyon merely knows about has no transcript, no queue and nothing to start: the
    // stream it gets is git status, which is what the changes panel and the rail badges read
    if (!r.wt) {
      ctx.reply({ t: "backfill", worktreeId: msg.worktreeId, events: [], log: [] });
      ctx.reply({ t: "queue", worktreeId: msg.worktreeId, items: [] });
      ctx.reply({ t: "agent-commands", worktreeId: msg.worktreeId, commands: [] });
      await gitAndPages(s, ctx, msg.worktreeId);
      return;
    }
    // the adapter, not the runtime: a cold worktree has its transcript on disk and nothing else.
    // The whole session goes: scrolling up has to reach the first prompt
    const agent = s.runtime.ensureAgent(r.wt).agent;
    ctx.reply({
      t: "backfill",
      worktreeId: msg.worktreeId,
      events: coalesce(agent.transcript()),
      log: s.runtime.recentLogs(msg.worktreeId),
    });
    ctx.reply({ t: "queue", worktreeId: msg.worktreeId, items: agent.queueItems });
    ctx.reply({ t: "agent-commands", worktreeId: msg.worktreeId, commands: agent.commands });
    await gitAndPages(s, ctx, msg.worktreeId);
  },

  unsubscribe(msg, ctx) {
    ctx.unsubscribe(msg.worktreeId);
  },

  // looking is what starts a cold worktree and wakes a sleeping one; the reply does not wait for it
  view(msg, ctx, s) {
    ctx.view(msg.worktreeId);
    // opening the plus is when the trunk follows origin: the row shown is the latest main, and
    // the fetch this costs is the one the plus is allowed
    const wt = msg.worktreeId ? s.state.worktree(msg.worktreeId) : undefined;
    if (wt && isLead(wt)) fireAndForget(wt.repoId, s.worktrees.syncTrunk(wt.repoId), "trunk sync");
  },

  seen(msg, _ctx, s) {
    s.turns.markSeen(msg.worktreeId);
  },

  "mark-unread"(msg, _ctx, s) {
    s.turns.markUnread(msg.worktreeId);
  },

  "set-draft"(msg, _ctx, s) {
    s.drafts.set(msg.boxId, msg.text, msg.clientId);
    s.worktrees.spare.typed(msg.boxId, msg.text);
  },

  "refresh-git"(msg, _ctx, s) {
    // the recount's repoTick also asks GitHub about the repo's open PRs (PrService)
    s.worktrees.recount(msg.repoId);
  },

  async visit(msg, _ctx, s) {
    await s.routes.visit(msg.worktreeId, msg.path, msg.title);
  },

  "page-title"(msg, _ctx, s) {
    s.routes.retitle(msg.worktreeId, msg.path, msg.title);
  },

  "forget-visit"(msg, _ctx, s) {
    s.routes.forget(msg.repoId, msg.path);
  },

  async chat(msg, _ctx, s) {
    await s.worktrees.send(msg.worktreeId, {
      text: msg.text,
      clientId: msg.clientId,
      context: msg.context,
      attachments: msg.attachments,
    });
  },

  async "create-worktree"(msg, _ctx, s) {
    await s.worktrees.create(msg.repoId, msg.prompt, {
      createdBy: msg.clientId,
      worktreeId: msg.worktreeId,
      variant: msg.variant,
      context: msg.context,
      attachments: msg.attachments,
      agent: msg.agent,
      profile: msg.profile,
      mode: msg.mode,
      model: msg.model,
      effort: msg.effort,
      carry: msg.carry,
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
    // plan + spawn in the background so the socket stays responsive: the rows appearing are the
    // word on it, and a task that could not start is the one thing worth a line. That reply may
    // land on a socket that has since closed; reply() tolerates that.
    fireAndForget(
      msg.repoId,
      (async () => {
        const agent = msg.agent ?? s.state.defaultAgent ?? DEFAULT_AGENT_ID;
        const tasks = (await s.planTasks(msg.prompt, repo.path, agent)) ?? [msg.prompt];
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
        if (failed) ctx.reply(shipped("", false, `batch: ${started} started, ${failed} failed (see daemon log)`));
      })(),
      "batch",
    );
  },

  async "archive-worktree"(msg, _ctx, s) {
    // no word back: the row leaving is the answer, and the rail's archived section is where an
    // archive says it can be undone
    await s.worktrees.archiveWorktree(msg.worktreeId);
  },

  "list-archived"(msg, ctx, s) {
    ctx.reply({ t: "archived", repoId: msg.repoId, items: s.worktrees.archived(msg.repoId) });
  },

  async "restore-worktree"(msg, _ctx, s) {
    await s.worktrees.restore(msg.archiveId, msg.clientId, msg.message);
  },

  async "delete-archived"(msg, _ctx, s) {
    await s.worktrees.deleteArchived(msg.archiveId);
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
      // an archived worktree's files are only in git, and its page reads them from there
      const kept = s.worktrees.readable(msg.worktreeId)
        ? null
        : await s.worktrees.archivedFile(msg.worktreeId, msg.path, msg.ref);
      const read = kept ? keptRead(kept.before, kept.after) : await s.files.read(msg.worktreeId, msg.path, msg.ref);
      ctx.reply({ ...head, ...read });
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

  async land(msg, ctx, s) {
    const { result, archiveIds } = await s.worktrees.land(msg.worktreeId, msg.message);
    // the same prefilled prompt sync offers on a conflict: the one failure an agent can be asked to fix
    const suggestion =
      !result.ok && result.conflict
        ? "Bring main into this branch and resolve the conflicts, then verify the app still works."
        : undefined;
    // a PR opened or merged: GitHub's word on it follows, so the box can say where it stands
    if (result.ok && (result.pr || s.state.worktree(msg.worktreeId)?.pr)) {
      fireAndForget(msg.worktreeId, s.prs.refresh(msg.worktreeId), "pr refresh");
    }
    await notify(
      s,
      ctx,
      msg.worktreeId,
      shipped(msg.worktreeId, result.ok, result.message, {
        merged: result.ok,
        url: result.url,
        // the worktree stays, with close offered in its box; what the chat's row offers up is its
        // variant siblings, if any
        archiveIds: archiveIds ?? [],
        ...(suggestion ? { suggestion } : {}),
      }),
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
        ? shipped(msg.worktreeId, false, `sync conflicts with ${defaultBranch}: prompt prefilled in chat`, {
            suggestion: `Merge ${defaultBranch} into this branch and resolve the conflicts, then verify the app still works.`,
          })
        : shipped(msg.worktreeId, result.ok, result.message),
    );
  },

  async "pull-main"(msg, ctx, s) {
    const result = await s.worktrees.pull(msg.worktreeId);
    await notify(s, ctx, msg.worktreeId, shipped(msg.worktreeId, result.ok, result.message));
  },

  "run-after-land"(msg, ctx, s) {
    // the run reports itself: `building` goes out on a self frame the moment it starts, and again
    // with whatever stopped it. All that is left here is the case where there is nothing to run.
    const repo = s.state.repo(msg.repoId);
    if (!repo) throw new UserError("no such project");
    if ((repo.config.afterLand ?? []).length === 0) {
      throw new UserError(`${repo.name} has no afterLand commands in ${repo.configFile}`);
    }
    s.afterLand.run(msg.repoId);
    ctx.reply({ t: "self", self: s.self.get() });
  },

  "restart-daemon"(_msg, _ctx, s) {
    const refused = s.restarter.request();
    if (refused) throw new UserError(refused);
  },

  "update-now"(_msg, _ctx, s) {
    return s.update.updateNow();
  },
  async commit(msg, ctx, s) {
    const result = await s.worktrees.commit(msg.worktreeId, msg.message);
    await notify(s, ctx, msg.worktreeId, shipped(msg.worktreeId, result.ok, result.message));
  },

  async graft(msg, ctx, s) {
    const { target } = await s.worktrees.graft(msg.targetId, msg.sourceIds);
    // the graft row on the target's chat is the word on it; the changes panel still needs telling
    await gitStatus(s, ctx, target.id);
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
    ctx.reply({ t: "files", worktreeId: msg.worktreeId, ...(await s.files.list(msg.worktreeId)) });
  },

  async search(msg, ctx, s) {
    const { hits, truncated } = await s.files.search(msg.worktreeId, msg.query);
    ctx.reply({ t: "search-results", worktreeId: msg.worktreeId, query: msg.query, hits, truncated });
  },

  async "find-element"(msg, ctx, s) {
    const { hits, sure } = await s.files.findElement(msg.worktreeId, msg.element);
    ctx.reply({ t: "element-sources", worktreeId: msg.worktreeId, seq: msg.seq, hits, sure });
  },

  async "design-scan"(msg, ctx, s) {
    const index = await s.design.scan(msg.worktreeId);
    ctx.reply({ t: "design-index", worktreeId: msg.worktreeId, index });
  },

  "stop-agent"(msg, _ctx, s) {
    requireRun(s, msg.worktreeId);
    s.turns.stoppedByPerson(msg.worktreeId);
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

  async "discard-file"(msg, _ctx, s) {
    await s.files.discard(msg.worktreeId, msg.path);
    // every tab's changes list re-reads from the git-status this pushes, and an editor open on the
    // file re-reads the file from that; the file leaving the list is the word on it
    s.hub.emit("filesChanged", msg.worktreeId);
  },

  async "write-file"(msg, ctx, s) {
    const head = { t: "file-written", worktreeId: msg.worktreeId, path: msg.path, seq: msg.seq } as const;
    try {
      const written = await s.files.write(msg.worktreeId, msg.path, msg.content, msg.base);
      ctx.reply({ ...head, ...written });
      // nothing said beyond the frame: autosave fires constantly; the changes list is the feedback, on every tab
      if (written.ok) s.hub.emit("filesChanged", msg.worktreeId);
    } catch (e) {
      // answered either way, as a read is: an unanswered write would hold the file's next save forever
      if (!(e instanceof UserError)) log.error(msg.worktreeId, "write-file failed", e);
      ctx.reply({ ...head, ok: false, reason: "refused", version: null, message: errorText(e) });
    }
  },

  async "confirm-config"(msg, _ctx, s) {
    await s.repos.confirmConfig(msg.repoId, msg.config, msg.kind);
  },

  async "register-repo"(msg, _ctx, s) {
    // the project's name in the pill and its rows in the rail are the answer
    await s.repos.register(msg.path);
  },

  async "create-repo"(msg, _ctx, s) {
    // A clone runs long enough that it becomes a thing the daemon holds and the shell watches,
    // rather than a promise this socket waits on: startImport validates and returns at once, and
    // the import pane is the feedback from there. A create is fast, so it stays a plain await.
    if (msg.mode === "clone") {
      s.repos.startImport({ parent: msg.parent, name: msg.name, url: msg.url ?? "" });
      return;
    }
    await s.repos.create(msg);
  },

  async "unmake-repo"(msg, _ctx, s) {
    // nothing said: the page it was asked from is the answer, with the project's name back in its field
    await s.repos.unmake(msg.repoId);
  },

  "cancel-import"(msg, _ctx, s) {
    s.repos.cancelImport(msg.id);
  },

  async "browse-path"(msg, ctx, _s) {
    ctx.reply({ t: "path-entries", query: msg.path, ...(await browsePath(msg.path)) });
  },

  async "choose-folder"(msg, ctx, s) {
    let path: string | null;
    try {
      path = await s.folderDialog.choose(msg.start, msg.purpose);
    } catch (e) {
      // the form is waiting on an answer to stop looking busy; the throw still reaches it as an error frame
      ctx.reply({ t: "folder-chosen", folder: null });
      throw e;
    }
    ctx.reply({ t: "folder-chosen", folder: path ? await describeFolder(path) : null });
  },

  "cancel-folder"(_msg, _ctx, s) {
    // the choose waiting on the dialog answers null, which is what tells the form it is over
    s.folderDialog.cancel();
  },

  async "forget-repo"(msg, _ctx, s) {
    await s.repos.forget(msg.repoId);
  },

  "set-theme"(msg, _ctx, s) {
    s.themes.setPrefs(msg.prefs);
    s.hub.emit("themesChanged");
  },

  // Stateless on purpose: the shell owns the clock, because it is the one that sleeps with the
  // laptop and has to recheck on waking. This just answers where the sun is for a zone.
  zone(msg, ctx, _s) {
    ctx.reply({ t: "daylight", ...daylightNow(msg.tz) });
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
    if (r.kind === "terminal") s.runtime.startLogin(msg.worktreeId, r.run);
  },

  "agent-retry"(msg, _ctx, s) {
    requireRun(s, msg.worktreeId);
    s.runtime.agentFor(msg.worktreeId)?.retry();
  },

  // No UserError when the ask has already closed: two shells can watch one worktree, and the
  // loser of that race would read a refusal about a card that is about to disappear anyway.
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
    s.worktrees.markPrompted(msg.worktreeId);
  },

  "exec-stop"(msg, _ctx, s) {
    requireRun(s, msg.worktreeId);
    s.exec.stop(msg.worktreeId);
  },

  async "search-refs"(msg, ctx, s) {
    const refs = await s.refs.search(msg.repoId, msg.query);
    ctx.reply({ t: "refs", repoId: msg.repoId, query: msg.query, refs });
  },

  async "search-chats"(msg, ctx, s) {
    const { hits, truncated } = await s.chats.search(msg.repoId, msg.query);
    ctx.reply({ t: "chat-hits", repoId: msg.repoId, query: msg.query, hits, truncated });
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
