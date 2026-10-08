// The worktree service tests' world: real git in a throwaway repo; fake agent/procs/proxy so
// nothing is spawned and no SDK is called. One file per area keeps each under the parallel
// runner's stride, and they all share this fixture.

import { afterEach, beforeEach } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { Hub } from "../../src/core/hub.ts";
import { SelfWatch } from "../../src/core/self.ts";
import { StateStore } from "../../src/core/state.ts";
import { ExecService } from "../../src/exec/service.ts";
import { PageErrorService } from "../../src/preview/errors.ts";
import { RenderService } from "../../src/preview/render.ts";
import { AfterLand } from "../../src/repos/afterLand.ts";
import { RepoRegistry } from "../../src/repos/registry.ts";
import { RuntimeRegistry } from "../../src/runtime/registry.ts";
import { ArtifactCache } from "../../src/worktrees/cache.ts";
import { FixService } from "../../src/worktrees/fix.ts";
import { HandoffService } from "../../src/worktrees/handoff.ts";
import { WorktreeService } from "../../src/worktrees/service.ts";
import { TurnService } from "../../src/worktrees/turns.ts";
import { fakeAgents, fakeFactories } from "./fakes.ts";
import { sh, tmpRepo } from "./tmp-repo.ts";

/** No daemon of toyon's own runs here, so nothing that lands in these repos can get ahead of one:
 * a registry needs the two anyway, and these are the pair that never has anything to say. */
export function noSelf(state: StateStore, hub: Hub) {
  const self = new SelfWatch(null);
  return { self, afterLand: new AfterLand({ state, hub, self }) };
}

export type World = ReturnType<typeof world>;
export function world() {
  const t = tmpRepo();
  const state = new StateStore(t.paths);
  const hub = new Hub();
  const f = fakeFactories();
  const agents = fakeAgents(t.paths.agentsDir);
  // main runs only while no spare stands in for it, as the daemon wires it
  const runtime = new RuntimeRegistry({
    hub,
    state,
    paths: t.paths,
    agents,
    bridgeScript: () => "",
    mainLeads: (repoId: string): boolean => worktrees.spare.current(repoId) === null,
    ...f.factories,
  });
  const exec = new ExecService({ state, runtime });
  // the namer's answer and how many times it was asked; `gate` holds an answer back, for a birth
  // ask still out when a turn ends
  const naming = { reply: null as string | null, calls: 0, gate: Promise.resolve() };
  // the version commands answered without a shell, so the key is the lockfiles and the platform
  const cache = new ArtifactCache({ paths: t.paths, state, hub, tool: async () => "1.0" });
  /** the landing messages a hook refused, each with what the hook said */
  const refused: Array<[worktreeId: string, said: string]> = [];
  hub.on("messageRefused", (id, said) => refused.push([id, said]));
  const fix = new FixService({ state, hub, runtime });
  const pageErrors = new PageErrorService({ hub, runtime, known: (id) => state.worktree(id) !== undefined });
  const render = new RenderService({ runtime, pageErrors, waitMs: 200 });
  const worktrees = new WorktreeService({
    state,
    hub,
    runtime,
    paths: t.paths,
    agents,
    cache,
    namer: async () => {
      naming.calls++;
      await naming.gate;
      return naming.reply;
    },
    watch: (id, command, run) => exec.watch(id, command, run),
    fix,
    pageErrors: (id) => pageErrors.ambient(id),
  });
  const turns = new TurnService({ state, hub, transcript: (id) => runtime.agentFor(id)?.transcript() ?? [] });
  const repos = new RepoRegistry({ state, hub, runtime, worktrees, ...noSelf(state, hub) });
  const handoff = new HandoffService({
    state,
    hub,
    runtime,
    create: (repoId, prompt, opts) => worktrees.create(repoId, prompt, opts),
  });
  return {
    ...t,
    state,
    hub,
    runtime,
    worktrees,
    turns,
    repos,
    registry: agents,
    naming,
    cache,
    refused,
    fix,
    pageErrors,
    render,
    handoff,
    ...f,
  };
}

/** the world under test, fresh before each test of a file that called useWorld() */
export let w: World;

/** a world per test: built before each, shut down and deleted after */
export function useWorld(): void {
  beforeEach(() => {
    w = world();
  });
  afterEach(async () => {
    await w.runtime.shutdown();
    w.repos.stopWatchers();
    w.cleanup();
  });
}

// a repo with no package.json detects as needsSetup; flip it so procs/spares behave as confirmed
export async function registered(): Promise<string> {
  const repo = await w.repos.register(w.repo);
  repo.needsSetup = false;
  repo.config = { run: { web: "true" } };
  w.state.save();
  return repo.id;
}

export const settle = () => new Promise((r) => setTimeout(r, 50));

/** The frame with its numbers and found list read, not as last known: a frame never waits on git,
 * so a test that asserts on a count or a found row waits here. A found row's own numbers come a
 * read after the row does, hence the loop. */
async function settledSnapshot(svc: WorktreeService) {
  let snap = svc.snapshot();
  while (await svc.settled()) snap = svc.snapshot();
  return snap;
}

export const counted = async (svc = w.worktrees) => (await settledSnapshot(svc)).rows;
export const countedTrunks = async (svc = w.worktrees) => (await settledSnapshot(svc)).trunks;

/** the route set on the record and the base that follows from it, as a settings save leaves them */
export async function setRoute(repoId: string, route: "merge" | "push" | "pr") {
  const repo = w.state.requireRepo(repoId);
  repo.config.land = { ...repo.config.land, route };
  await w.repos.refreshBase(repo);
}

/** wait for background work to reach a state, where a fixed settle loses the race under load */
export async function until(done: () => boolean, ms = 15_000): Promise<void> {
  const stop = Date.now() + ms;
  while (!done()) {
    if (Date.now() > stop) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}

// a worktree someone made in a terminal, which is the whole reason discovery exists
export function foreignWorktree(name: string, branch: string): string {
  const dir = join(dirname(w.repo), name);
  sh(w.repo, "git", "worktree", "add", "-q", "-b", branch, dir, "main");
  w.worktrees.invalidateDiscovered();
  return dir;
}

/** the id the row at this directory was pushed with; adopt is addressed by it. A directory that
 * was never a worktree has no row, and an id nothing resolves is what the shell would send then. */
export async function foundId(dir: string): Promise<string> {
  w.worktrees.invalidateDiscovered();
  const want = existsSync(dir) ? realpathSync(dir) : dir;
  const row = (await w.worktrees.discovered()).find((r) => realpathSync(r.path) === want);
  return row?.id ?? "nope";
}

export const adoptDir = async (dir: string, createdBy?: string) => w.worktrees.adopt(await foundId(dir), createdBy);
