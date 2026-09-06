// One handler per ClientMsg kind, exhaustive by type: adding a message without a handler is a
// compile error. Handlers marshal (pick fields, shape replies) and call a service; they do not
// run git or decide policy.

import type { ClientMsg, ServerMsg } from "@orchardist/shared";
import { pickTheme } from "@orchardist/shared";
import { planTasks } from "../agent/llm.ts";
import { UserError } from "../core/errors.ts";
import type { Hub } from "../core/hub.ts";
import { fireAndForget, log } from "../core/log.ts";
import type { StateStore } from "../core/state.ts";
import type { FileService } from "../files/service.ts";
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
  runtime: RuntimeRegistry;
  themes: ThemeStore;
}

export interface HandlerCtx {
  /** to the socket that sent the message */
  reply(msg: ServerMsg): void;
  /** to every connected socket */
  broadcast(msg: ServerMsg): void;
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

const gitStatus = (s: Services, ctx: HandlerCtx, worktreeId: string) => {
  const msg = s.worktrees.gitStatus(worktreeId);
  if (msg) ctx.reply(msg);
};

export const handlers: { [K in ClientMsg["t"]]: Handler<K> } = {
  subscribe(msg, ctx, s) {
    const agent = s.runtime.agentFor(msg.worktreeId);
    const events = agent?.transcript() ?? [];
    ctx.reply({ t: "backfill", worktreeId: msg.worktreeId, events: events.slice(-1000) });
    ctx.reply({ t: "queue", worktreeId: msg.worktreeId, items: agent?.queueItems ?? [] });
    gitStatus(s, ctx, msg.worktreeId);
  },

  chat(msg, _ctx, s) {
    s.state.requireWorktree(msg.worktreeId);
    const agent = s.runtime.agentFor(msg.worktreeId);
    if (!agent) throw new UserError("worktree still starting; try again in a moment");
    agent.send(msg.text, msg.context, msg.pick);
    s.hub.emit("worktreesChanged"); // queued-count may have changed
  },

  async "create-worktree"(msg, _ctx, s) {
    await s.worktrees.create(msg.repoId, msg.prompt, {
      baseWorktreeId: msg.baseWorktreeId,
      variant: msg.variant,
      context: msg.context,
      pick: msg.pick,
    });
  },

  "batch-worktrees"(msg, ctx, s) {
    const repo = s.state.requireRepo(msg.repoId);
    ctx.reply(toast("", true, "batch: planning tasks…"));
    // plan + spawn in the background so the socket stays responsive. The final reply may land on
    // a socket that has since closed; reply() tolerates that.
    fireAndForget(
      msg.repoId,
      (async () => {
        const tasks = (await planTasks(msg.prompt, repo.path)) ?? [msg.prompt];
        let failed = 0;
        for (const task of tasks) {
          try {
            await s.worktrees.create(msg.repoId, task);
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

  "restart-proc"(msg, _ctx, s) {
    s.runtime.restartProc(msg.worktreeId, msg.proc);
  },

  "git-status"(msg, ctx, s) {
    gitStatus(s, ctx, msg.worktreeId);
  },

  async "file-diff"(msg, ctx, s) {
    if (!s.state.worktree(msg.worktreeId)) return;
    const { before, after } = await s.files.diff(msg.worktreeId, msg.path);
    ctx.reply({ t: "file-diff", worktreeId: msg.worktreeId, path: msg.path, before, after });
  },

  ship(msg, ctx, s) {
    const result = s.worktrees.ship(msg.worktreeId);
    ctx.reply(toast(msg.worktreeId, result.ok, result.message, { url: result.url }));
    gitStatus(s, ctx, msg.worktreeId);
  },

  async "merge-main"(msg, ctx, s) {
    const { result, removeIds } = await s.worktrees.merge(msg.worktreeId);
    ctx.reply(toast(msg.worktreeId, result.ok, result.message, { merged: result.ok, removeIds }));
    gitStatus(s, ctx, msg.worktreeId);
  },

  async "sync-main"(msg, ctx, s) {
    const { result, defaultBranch } = await s.worktrees.sync(msg.worktreeId);
    ctx.reply(
      result.ok
        ? toast(msg.worktreeId, true, result.message)
        : toast(msg.worktreeId, false, `sync conflicts with ${defaultBranch} — prompt prefilled in chat`, {
            suggestion: `Merge ${defaultBranch} into this branch and resolve the conflicts, then verify the app still works.`,
          }),
    );
    gitStatus(s, ctx, msg.worktreeId);
  },

  commit(msg, ctx, s) {
    const result = s.worktrees.commit(msg.worktreeId, msg.message);
    ctx.reply(toast(msg.worktreeId, result.ok, result.message));
    gitStatus(s, ctx, msg.worktreeId);
  },

  async combine(msg, ctx, s) {
    const wt = await s.worktrees.combine(msg.worktreeIds);
    ctx.reply(
      toast(wt.id, true, `grafted: ${wt.title} — local merge of ${msg.worktreeIds.length} branches, nothing pushed`),
    );
  },

  async "rename-worktree"(msg, _ctx, s) {
    await s.worktrees.rename(msg.worktreeId, msg.title);
  },

  "list-files"(msg, ctx, s) {
    ctx.reply({ t: "files", worktreeId: msg.worktreeId, paths: s.files.list(msg.worktreeId) });
  },

  search(msg, ctx, s) {
    const { hits, truncated } = s.files.search(msg.worktreeId, msg.query);
    ctx.reply({ t: "search-results", worktreeId: msg.worktreeId, query: msg.query, hits, truncated });
  },

  "stop-agent"(msg, _ctx, s) {
    s.runtime.agentFor(msg.worktreeId)?.stop();
  },

  async "pick-variant"(msg, _ctx, s) {
    await s.worktrees.pickVariant(msg.worktreeId);
  },

  unqueue(msg, _ctx, s) {
    s.runtime.agentFor(msg.worktreeId)?.unqueue(msg.index);
  },

  async "changed-ranges"(msg, ctx, s) {
    if (!s.state.worktree(msg.worktreeId)) return;
    const { ranges, lineOffset } = await s.files.changedRanges(msg.worktreeId, msg.path);
    ctx.reply({ t: "changed-ranges", worktreeId: msg.worktreeId, path: msg.path, ranges, lineOffset });
  },

  reveal(msg, _ctx, s) {
    s.files.reveal(msg.worktreeId, msg.path);
  },

  "discard-file"(msg, ctx, s) {
    s.files.discard(msg.worktreeId, msg.path);
    ctx.reply(toast(msg.worktreeId, true, `discarded ${msg.path}`));
    gitStatus(s, ctx, msg.worktreeId);
  },

  async "write-file"(msg, ctx, s) {
    await s.files.write(msg.worktreeId, msg.path, msg.content);
    // no toast: autosave fires constantly; the changes list is the feedback
    gitStatus(s, ctx, msg.worktreeId);
  },

  "confirm-config"(msg, _ctx, s) {
    s.repos.confirmConfig(msg.repoId, msg.config);
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

  "rescan-themes"(_msg, _ctx, s) {
    s.themes.load();
    s.hub.emit("themesChanged");
  },
};

/** dispatch one validated message */
export async function dispatch(msg: ClientMsg, ctx: HandlerCtx, s: Services): Promise<void> {
  const h = handlers[msg.t] as Handler<typeof msg.t>;
  await h(msg, ctx, s);
}
