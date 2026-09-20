import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeAgents, fakeFactories } from "../../test/helpers/fakes.ts";
import { sh, tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { Hub } from "../core/hub.ts";
import { SelfWatch } from "../core/self.ts";
import { StateStore } from "../core/state.ts";
import { GIT } from "../git/exec.ts";
import { RuntimeRegistry } from "../runtime/registry.ts";
import { WorktreeService } from "../worktrees/service.ts";
import { AfterLand } from "./afterLand.ts";
import { RepoRegistry } from "./registry.ts";

// Real commands on a pty in a throwaway repo, so what a run prints and how it ends are the real
// thing; fake agents and procs so nothing else is spawned.

type World = ReturnType<typeof world>;
/** `own` makes the repo the checkout this daemon runs from, the one whose runs the self notice reports */
function world(own = false, settled?: () => Promise<void>) {
  const t = tmpRepo();
  const state = new StateStore(t.paths);
  const hub = new Hub();
  const f = fakeFactories();
  const agents = fakeAgents(t.paths.agentsDir);
  const runtime = new RuntimeRegistry({ hub, state, paths: t.paths, agents, bridgeScript: () => "", ...f.factories });
  const worktrees = new WorktreeService({ state, hub, runtime, paths: t.paths, agents, namer: async () => null });
  // the registry keeps a repo at the root git reports, its real path, and the self watch matches on it exactly
  const self = new SelfWatch(own ? realpathSync(t.repo) : null);
  const afterLand = new AfterLand({ state, hub, self, settled });
  const repos = new RepoRegistry({ state, hub, runtime, worktrees, afterLand, self });
  const failed: Array<{ worktreeId: string; message: string }> = [];
  hub.on("failed", (worktreeId, message) => failed.push({ worktreeId, message }));
  return { ...t, state, hub, runtime, repos, self, afterLand, failed };
}

let w: World;
afterEach(async () => {
  await w.runtime.shutdown();
  w.repos.stopWatchers();
  w.cleanup();
});

/** the repo registered with these `afterLand` commands, and its main worktree */
async function registered(commands: string[]) {
  const repo = await w.repos.register(w.repo);
  repo.needsSetup = false;
  repo.config = { ...repo.config, afterLand: commands };
  w.state.save();
  const main = w.state.worktrees.find((x) => x.repoId === repo.id && x.kind === "main");
  if (!main) throw new Error("no main worktree");
  return { repo, main };
}

async function until(cond: () => boolean): Promise<void> {
  const end = Date.now() + 10_000;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}
const settled = (repoId: string) => until(() => !w.afterLand.busy(repoId));

describe("afterLand", () => {
  test("a land during a run means one more run when it ends, however many arrive", async () => {
    w = world();
    const { repo } = await registered(["echo ran >> ran.txt; sleep 0.3"]);
    w.afterLand.run(repo.id);
    expect(w.afterLand.busy(repo.id)).toBe(true);
    w.afterLand.run(repo.id);
    w.afterLand.run(repo.id);
    await settled(repo.id);
    expect(readFileSync(join(w.repo, "ran.txt"), "utf8")).toBe("ran\nran\n");
  });

  test("a run waits for the wake queue to drain before it starts", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    w = world(false, () => gate);
    const { repo } = await registered(["echo ran >> ran.txt"]);
    w.afterLand.run(repo.id);
    expect(w.afterLand.busy(repo.id)).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(join(w.repo, "ran.txt"))).toBe(false);
    release();
    await settled(repo.id);
    expect(readFileSync(join(w.repo, "ran.txt"), "utf8")).toBe("ran\n");
  });

  test("a clean run says nothing", async () => {
    w = world();
    const { repo } = await registered(["true"]);
    w.afterLand.run(repo.id);
    await settled(repo.id);
    expect(w.failed).toEqual([]);
  });

  test("a run that stops is said on the project's main worktree, with the line that stopped it", async () => {
    w = world();
    const { repo, main } = await registered(["echo boom; false", "echo never >> ran.txt"]);
    w.afterLand.run(repo.id);
    await settled(repo.id);
    expect(w.failed).toEqual([{ worktreeId: main.id, message: "After landing, echo boom; false stopped: boom" }]);
    expect(existsSync(join(w.repo, "ran.txt"))).toBe(false);
  });

  test("a command that stops without printing is named with its exit code", async () => {
    w = world();
    const { repo, main } = await registered(["exit 4"]);
    w.afterLand.run(repo.id);
    await settled(repo.id);
    expect(w.failed).toEqual([{ worktreeId: main.id, message: "After landing, exit 4 exited 4" }]);
  });

  test("the checkout toyon runs from reports on the self notice instead", async () => {
    w = world(true);
    await w.self.start();
    const { repo } = await registered(["false"]);
    // main moved under the daemon by a shell change, so there is a notice to report into
    mkdirSync(join(w.repo, "packages/shell"), { recursive: true });
    writeFileSync(join(w.repo, "packages/shell/x.ts"), "");
    sh(w.repo, GIT, "add", "-A");
    sh(w.repo, GIT, "commit", "-q", "-m", "shell");
    expect(await w.self.check(repo)).toBe(true);
    w.afterLand.run(repo.id);
    await settled(repo.id);
    expect(w.failed).toEqual([]);
    expect(w.self.get()).toMatchObject({ rebuild: true, building: false, buildFailed: "false (exit 1)" });
  });
});
