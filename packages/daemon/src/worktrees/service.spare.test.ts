import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fakeFactories } from "../../test/helpers/fakes.ts";
import { sh, tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { noSelf, registered, settle, until, useWorld, w } from "../../test/helpers/world.ts";
import { UserError } from "../core/errors.ts";
import { Hub } from "../core/hub.ts";
import { StateStore } from "../core/state.ts";
import { git } from "../git/exec.ts";
import { RepoRegistry } from "../repos/registry.ts";
import { RuntimeRegistry } from "../runtime/registry.ts";
import { FixService } from "./fix.ts";
import { WorktreeService } from "./service.ts";

// The spare that stands in for main, a daemon's boot over what it left, and what the rail reads off a row: its counts and its unseen ring.

useWorld();

describe("spare pool", () => {
  test("create claims a ready spare, and the task's agent IS the spare's agent", async () => {
    const repoId = await registered();
    await w.worktrees.spare.ensure(repoId);
    const spare = w.state.worktrees.find((x) => x.kind === "spare")!;
    expect(spare).toBeDefined();
    const spareAgent = w.agents.get(spare.id)!;
    const wt = await w.worktrees.create(repoId, "use the spare");
    expect(wt.id).toBe(spare.id);
    expect(wt.kind).toBe("worktree");
    expect((await git(wt.path, "branch", "--show-current")).out).toBe(wt.branch);
    expect(spareAgent.sent[0]?.text).toBe("use the spare");
    expect(w.runtime.get(wt.id)?.agent).toBe(spareAgent);
    // the spare had no agent; the task's choice is stamped before its first prompt
    expect(wt.agent).toBe("claude");
  });

  test("a claim carries the mode, model and effort the task asked for, like a cold create does", async () => {
    const repoId = await registered();
    await w.worktrees.spare.ensure(repoId);
    const wt = await w.worktrees.create(repoId, "use the spare", { mode: "plan", model: "big", effort: "high" });
    expect(wt.kind).toBe("worktree");
    expect([wt.mode, wt.model, wt.effort]).toEqual(["plan", "big", "high"]);
    w.worktrees.setEffort(wt.id, "");
    expect(w.state.requireWorktree(wt.id).effort).toBeUndefined();
    const spare = w.state.worktrees.find((x) => x.kind === "spare");
    if (spare) expect(() => w.worktrees.setEffort(spare.id, "high")).toThrow(UserError);
  });

  test("the warm spare is the lead row, main leaves the list for it, and a claim keeps the row's id", async () => {
    const repoId = await registered();
    const main = w.state.worktrees.find((x) => x.repoId === repoId && x.kind === "main")!;
    expect((await w.worktrees.rows()).map((r) => r.id)).toEqual([main.id]);
    await w.worktrees.spare.ensure(repoId);
    const spare = w.state.worktrees.find((x) => x.kind === "spare")!;
    const rows = await w.worktrees.rows();
    expect(rows.map((r) => [r.id, r.worktree?.kind])).toEqual([[spare.id, "spare"]]);
    // what main says rides beside the rows, under its own id
    expect((await w.worktrees.trunks())[repoId]).toMatchObject({ id: main.id, dirty: 0, empty: false });
    const wt = await w.worktrees.create(repoId, "use the spare", { worktreeId: spare.id });
    expect(wt.id).toBe(spare.id);
    expect((await w.worktrees.rows()).find((r) => r.id === wt.id)?.worktree?.kind).toBe("worktree");
    // the next one warms in the background and says so with a frame once it is ready, and is the
    // lead row from then on
    let changed = 0;
    w.hub.on("worktreesChanged", () => changed++);
    await until(() => w.state.worktrees.some((x) => x.kind === "spare"));
    await settle();
    const next = w.state.worktrees.find((x) => x.kind === "spare")!;
    expect(next.id).not.toBe(wt.id);
    expect((await w.worktrees.rows()).map((r) => r.id).sort()).toEqual([next.id, wt.id].sort());
    expect(changed).toBeGreaterThan(0);
  });

  test("a claim reserves the next spare at once; its deps and servers wait for the claimed one's preview", async () => {
    const repoId = await registered();
    await w.worktrees.spare.ensure(repoId);
    // a preview that takes its time: the finish waits on it
    const awaited: string[] = [];
    let answer: (() => void) | null = null;
    w.runtime.awaitPreview = async (id) => {
      awaited.push(id);
      await new Promise<void>((r) => {
        answer = r;
      });
      return null;
    };
    const wt = await w.worktrees.create(repoId, "task");
    // the row is there from the claim, so the plus never leaves the rail and main never stands
    // in; nothing slow has run on it
    const next = w.state.worktrees.find((x) => x.kind === "spare")!;
    expect(next).toBeDefined();
    await until(() => awaited.length > 0);
    expect(awaited).toEqual([wt.id]);
    expect(next.id).not.toBe(wt.id);
    expect((await w.worktrees.rows()).map((r) => r.id).sort()).toEqual([next.id, wt.id].sort());
    await settle();
    expect(next.phase).toBe("reserved");
    expect(w.runtime.get(next.id)?.procs ?? null).toBeNull();
    answer!();
    await until(() => next.phase === "ready");
    expect(w.runtime.get(next.id)?.procs).toBeTruthy();
    // the phase is the record's: written, so a restart would know where it was
    expect(w.state.worktree(next.id)?.phase).toBe("ready");
  });

  test("a send into the reserved row claims it as it is, and its finish runs on for the task", async () => {
    const repoId = await registered();
    await w.worktrees.spare.ensure(repoId);
    // every finish waits on a preview that never answers until told; from then on they all do
    const waiting: (() => void)[] = [];
    let answered = false;
    const answer = () => {
      answered = true;
      for (const r of waiting.splice(0)) r();
    };
    w.runtime.awaitPreview = async () => {
      if (!answered) await new Promise<void>((r) => waiting.push(r));
      return null;
    };
    await w.worktrees.create(repoId, "first");
    const held = w.state.worktrees.find((x) => x.kind === "spare")!;
    expect(held.phase).toBe("reserved");
    // typed into before the stagger released it: the message does not wait for deps
    const wt = await w.worktrees.create(repoId, "typed at once", { worktreeId: held.id });
    expect(wt.id).toBe(held.id);
    expect(wt.kind).toBe("worktree");
    expect(wt.phase).toBeUndefined();
    expect(w.agents.get(wt.id)?.sent[0]?.text).toBe("typed at once");
    // the finish is the task's: its procs come up from it, and the next row is reserved beside it
    expect(w.state.worktrees.some((x) => x.kind === "spare" && x.id !== wt.id)).toBe(true);
    answer();
    await until(() => !!w.runtime.get(wt.id)?.procs);
    await until(() => w.worktrees.spare.current(repoId)?.ready === true);
  });

  test("a spare warmed under one agent is restarted for a task that asks for another", async () => {
    const repoId = await registered();
    await w.worktrees.spare.ensure(repoId);
    const spare = w.state.worktrees.find((x) => x.kind === "spare")!;
    const agent = w.agents.get(spare.id)!;
    await agent.warm();
    expect(agent.runningAgent).toBe("claude");
    const wt = await w.worktrees.create(repoId, "same agent", { agent: "claude" });
    expect(wt.id).toBe(spare.id);
    expect(agent.restarts).toBe(0);
    // the refill's record lands before its runtime; the agent exists once the warm-up is done
    await until(() => w.worktrees.spare.current(repoId)?.ready === true);
    const next = w.state.worktrees.find((x) => x.kind === "spare")!;
    const nextAgent = w.agents.get(next.id)!;
    await nextAgent.warm();
    const other = await w.worktrees.create(repoId, "other agent", { agent: "codex" });
    expect(other.id).toBe(next.id);
    expect(nextAgent.restarts).toBe(1);
    expect(nextAgent.sent[0]?.text).toBe("other agent");
  });

  test("a claim naming a spare still warming takes it now; one naming a row already claimed goes cold", async () => {
    const repoId = await registered();
    // a setup step that takes its time, so the warm-up is still under way when the send arrives
    w.state.requireRepo(repoId).config.setup = ["sleep 0.5"];
    // the warm-up under way: the row is on screen before it is ready, and a send from it is
    // answered by that row rather than by a cold checkout beside it
    const warming = w.worktrees.spare.ensure(repoId);
    await until(() => w.state.worktrees.some((x) => x.kind === "spare"));
    const spare = w.state.worktrees.find((x) => x.kind === "spare")!;
    expect(w.worktrees.spare.current(repoId)).toEqual({ worktreeId: spare.id, ready: false });
    const wt = await w.worktrees.create(repoId, "typed early", { worktreeId: spare.id });
    await warming;
    expect(wt.id).toBe(spare.id);
    expect(wt.kind).toBe("worktree");
    // a second tab on the same row: the first send took it, so the second is a worktree of its own
    const other = await w.worktrees.create(repoId, "typed elsewhere", { worktreeId: spare.id });
    expect(other.id).not.toBe(spare.id);
    expect(other.kind).toBe("worktree");
    // ensure() joins the warm-up running rather than starting a second
    const a = w.worktrees.spare.ensure(repoId);
    const b = w.worktrees.spare.ensure(repoId);
    await Promise.all([a, b]);
    expect(w.state.worktrees.filter((x) => x.kind === "spare")).toHaveLength(1);
  });

  test("a claimed spare is born on a branch named for its directory, and a rename moves only the branch", async () => {
    const repoId = await registered();
    await w.worktrees.spare.ensure(repoId);
    const wt = await w.worktrees.create(repoId, "use the spare");
    const path = wt.path;
    expect(basename(path)).toBe(`wt-${wt.id.slice(0, 4)}`);
    expect(wt.branch).toBe(`toyon/${basename(path)}`);
    expect(wt.title).toBe("Use the spare");
    expect(wt.unnamed).toBe(true);
    await w.worktrees.rename(wt.id, "Better Name");
    // the title is read as it was typed; the branch carries its slug; the checkout stays put
    expect(wt.title).toBe("Better Name");
    expect(wt.unnamed).toBeUndefined();
    expect(wt.branch).toBe("toyon/better-name");
    expect(wt.path).toBe(path);
    expect(sh(w.repo, "git", "branch", "--list", "toyon/better-name")).toContain("toyon/better-name");
  });

  test("a name that did not come at birth is asked for again when a turn finishes", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "make the header sticky");
    await until(() => w.naming.calls === 1);
    await settle();
    expect(wt.unnamed).toBe(true);
    // the turn ran on an agent that could reach its API; the ask is made from the task's words
    w.naming.reply = "sticky header";
    w.agents.get(wt.id)!.note({ type: "user-message", text: "make the header sticky", ts: 1 });
    w.hub.emit("agentStatus", wt.id, "working");
    w.hub.emit("agentStatus", wt.id, "idle");
    await until(() => !wt.unnamed);
    expect(w.naming.calls).toBe(2);
    expect(wt.title).toBe("sticky header");
    expect(wt.branch).toBe("toyon/sticky-header");
    // named: a later turn asks nothing
    w.naming.reply = "something else";
    w.hub.emit("agentStatus", wt.id, "working");
    w.hub.emit("agentStatus", wt.id, "idle");
    await settle();
    expect(w.naming.calls).toBe(2);
    expect(wt.title).toBe("sticky header");
  });

  test("a turn that ends while the birth ask is still out does not ask twice, and a failed turn asks nothing", async () => {
    const repoId = await registered();
    let answer!: () => void;
    w.naming.gate = new Promise<void>((r) => {
      answer = r;
    });
    w.naming.reply = "slow name";
    const wt = await w.worktrees.create(repoId, "make the header sticky");
    await until(() => w.naming.calls === 1);
    w.agents.get(wt.id)!.note({ type: "user-message", text: "make the header sticky", ts: 1 });
    w.hub.emit("agentStatus", wt.id, "working");
    w.hub.emit("agentStatus", wt.id, "idle");
    await settle();
    expect(w.naming.calls).toBe(1);
    answer();
    await until(() => !wt.unnamed);
    expect(wt.title).toBe("slow name");
    // a placeholder on a row whose turn failed waits for a turn that finishes
    w.naming.reply = null;
    const other = await w.worktrees.create(repoId, "tidy the footer");
    await until(() => w.naming.calls === 2);
    await settle();
    expect(other.unnamed).toBe(true);
    w.agents.get(other.id)!.note({ type: "user-message", text: "tidy the footer", ts: 1 });
    w.hub.emit("agentStatus", other.id, "working");
    w.hub.emit("agentStatus", other.id, "error");
    await settle();
    expect(w.naming.calls).toBe(2);
    w.naming.reply = "footer";
    w.hub.emit("agentStatus", other.id, "working");
    w.hub.emit("agentStatus", other.id, "idle");
    await until(() => !other.unnamed);
    expect(w.naming.calls).toBe(3);
    expect(other.title).toBe("footer");
  });

  test("worktrees sharing a title get branches that never collide", async () => {
    const repoId = await registered();
    const a = await w.worktrees.create(repoId, "first task");
    const b = await w.worktrees.create(repoId, "second task");
    await w.worktrees.rename(a.id, "same");
    await w.worktrees.rename(b.id, "same");
    expect([a.title, b.title]).toEqual(["same", "same"]);
    expect(a.branch).toBe("toyon/same");
    expect(b.branch).toBe("toyon/same-2");
  });

  test("a renamed worktree keeps the title as words and gives its branch the slug", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "make the header sticky");
    await w.worktrees.rename(wt.id, "  Sticky header!  ");
    expect(wt.title).toBe("Sticky header");
    expect(wt.branch).toBe("toyon/sticky-header");
    expect(sh(w.repo, "git", "branch", "--list", "toyon/sticky-header")).toContain("toyon/sticky-header");
  });

  test("a title git cannot spell is still the title, and the branch stays where it is", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "make the header sticky");
    const before = wt.branch;
    await w.worktrees.rename(wt.id, "日本語");
    expect(wt.title).toBe("日本語");
    expect(wt.branch).toBe(before);
  });

  test("a spare the pool has let go of is not a row, and the spare can be read like any row", async () => {
    const repoId = await registered();
    await w.worktrees.spare.ensure(repoId);
    const spare = w.state.worktrees.find((x) => x.kind === "spare")!;
    // a stale extra as an older daemon might have left, which adopt() prunes: never a row
    w.state.addWorktree({ ...spare, id: "stale-spare", path: `${spare.path}-gone`, proxyPort: 1 });
    expect((await w.worktrees.rows()).map((r) => r.id)).toEqual([spare.id]);
    expect(w.worktrees.readable(spare.id)?.path).toBe(spare.path);
    expect((await w.worktrees.gitStatus(spare.id))?.files).toEqual([]);
    await expect(w.worktrees.sync(spare.id)).rejects.toBeInstanceOf(UserError);
  });
});

describe("boot", () => {
  test("prunes worktrees whose directory is gone and keeps one spare", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "task");
    await settle();
    await w.worktrees.spare.ensure(repoId);
    // a second spare row as an older daemon might have left behind
    const spare = w.state.worktrees.find((x) => x.kind === "spare")!;
    w.state.addWorktree({ ...spare, id: "stale-spare", path: `${spare.path}-gone`, proxyPort: 1 });
    // simulate a daemon restart: fresh services over the same state file
    await w.runtime.shutdown();
    sh(w.repo, "git", "worktree", "remove", "--force", wt.path);
    const state2 = new StateStore(w.paths);
    const hub2 = new Hub();
    const f2 = fakeFactories();
    const runtime2 = new RuntimeRegistry({
      hub: hub2,
      state: state2,
      paths: w.paths,
      agents: w.registry,
      bridgeScript: () => "",
      mainLeads: (repoId: string): boolean => worktrees2.spare.current(repoId) === null,
      ...f2.factories,
    });
    const worktrees2 = new WorktreeService({
      state: state2,
      hub: hub2,
      runtime: runtime2,
      paths: w.paths,
      agents: w.registry,
      namer: async () => null,
      fix: new FixService({ state: state2, hub: hub2, runtime: runtime2 }),
    });
    const repos2 = new RepoRegistry({
      state: state2,
      hub: hub2,
      runtime: runtime2,
      worktrees: worktrees2,
      ...noSelf(state2, hub2),
    });
    await repos2.boot();
    await settle();
    expect(state2.worktree(wt.id)).toBeUndefined();
    expect(state2.worktree("stale-spare")).toBeUndefined();
    expect(state2.worktrees.filter((x) => x.kind === "spare").length).toBe(1);
    // boot starts nothing; main never starts while the adopted spare stands in for it, and a look
    // at the spare, which is the row on screen, is what starts it
    const main = state2.worktrees.find((x) => x.kind === "main")!;
    const adopted = state2.worktrees.find((x) => x.kind === "spare")!;
    expect(runtime2.get(main.id)?.procs ?? null).toBeNull();
    repos2.touch(main.id);
    await settle();
    expect(runtime2.get(main.id)?.procs ?? null).toBeNull();
    expect(runtime2.get(adopted.id)?.procs ?? null).toBeNull();
    // the adopted spare comes back warm once the repo is in use: procs up, so the plus has a
    // preview and a claim hands over a running worktree
    repos2.warm(repoId);
    await settle();
    await settle();
    expect(runtime2.get(adopted.id)?.procs).toBeTruthy();
    expect((await worktrees2.rows()).map((r) => r.id)).toEqual([adopted.id]);
    await runtime2.shutdown();
    repos2.stopWatchers();
  });

  test("touching a worktree starts it alone; warming its repo brings up the spare and nothing else", async () => {
    const repoId = await registered();
    const a = await w.worktrees.create(repoId, "a");
    const b = await w.worktrees.create(repoId, "b");
    const other = tmpRepo();
    try {
      const otherId = (await w.repos.register(other.repo)).id;
      const otherMain = w.state.worktrees.find((x) => x.repoId === otherId && x.kind === "main")!;
      await settle();
      // restart over the same state: everything comes back cold
      await w.runtime.shutdown();
      const state2 = new StateStore(w.paths);
      const hub2 = new Hub();
      const f2 = fakeFactories();
      const runtime2 = new RuntimeRegistry({
        hub: hub2,
        state: state2,
        paths: w.paths,
        agents: w.registry,
        bridgeScript: () => "",
        mainLeads: (repoId: string): boolean => worktrees2.spare.current(repoId) === null,
        ...f2.factories,
      });
      const worktrees2 = new WorktreeService({
        state: state2,
        hub: hub2,
        runtime: runtime2,
        paths: w.paths,
        agents: w.registry,
        namer: async () => null,
        fix: new FixService({ state: state2, hub: hub2, runtime: runtime2 }),
      });
      const repos2 = new RepoRegistry({
        state: state2,
        hub: hub2,
        runtime: runtime2,
        worktrees: worktrees2,
        ...noSelf(state2, hub2),
      });
      await repos2.boot();
      await settle();
      expect(runtime2.runningCount()).toBe(0);
      repos2.touch(a.id);
      await settle();
      const up = (id: string) => !!runtime2.get(id)?.procs;
      const spareUp = () => state2.worktrees.some((x) => x.repoId === repoId && x.kind === "spare" && up(x.id));
      expect([up(a.id), up(b.id), spareUp(), up(otherMain.id)]).toEqual([true, false, false, false]);
      repos2.warm(repoId);
      await until(spareUp);
      expect([up(a.id), up(b.id), up(otherMain.id)]).toEqual([true, false, false]);
      // a touch of an id toyon has no record for is nothing, not an error
      repos2.touch("nope");
      await settle();
      await runtime2.shutdown();
      repos2.stopWatchers();
    } finally {
      other.cleanup();
    }
  });
});

// The rail's counts are cached for ten seconds and recounted on a frame, which on its own left a row
// reading clean while its changes list showed files. Each of these moves the number without waiting
// out the cache.
describe("rail counts", () => {
  const dirtyOf = async (id: string) => (await w.worktrees.rows()).find((x) => x.id === id)?.dirty;
  const opened = async (repoId: string, branch: string) => {
    sh(w.repo, "git", "branch", branch, "main");
    const wt = await w.worktrees.openRef(repoId, "branch", branch);
    await settle();
    expect(await dirtyOf(wt.id)).toBe(0);
    return wt;
  };

  test("a git status read moves the row's count at once, and says so", async () => {
    const repoId = await registered();
    const wt = await opened(repoId, "counted");
    writeFileSync(join(wt.path, "wip.txt"), "x\n");
    // still inside the cache: the rows alone would go on reading clean
    expect(await dirtyOf(wt.id)).toBe(0);
    let changed = 0;
    w.hub.on("worktreesChanged", () => changed++);
    await w.worktrees.gitStatus(wt.id);
    expect(await dirtyOf(wt.id)).toBe(1);
    expect(changed).toBeGreaterThan(0);
  });

  test("a turn ending recounts its row", async () => {
    const repoId = await registered();
    const wt = await opened(repoId, "turned");
    writeFileSync(join(wt.path, "wip.txt"), "x\n");
    w.hub.emit("agentStatus", wt.id, "working");
    w.hub.emit("agentStatus", wt.id, "idle");
    expect(await dirtyOf(wt.id)).toBe(1);
  });

  test("a recount drops every row's cache and ticks the repo", async () => {
    const repoId = await registered();
    const wt = await opened(repoId, "recounted");
    writeFileSync(join(wt.path, "wip.txt"), "x\n");
    const ticks: string[] = [];
    w.hub.on("repoTick", (id) => ticks.push(id));
    w.worktrees.recount(repoId);
    expect(ticks).toEqual([repoId]);
    expect(await dirtyOf(wt.id)).toBe(1);
  });
});

// The rail rings a worktree whose turn ended while nobody was looking. Green alone cannot separate
// "just finished" from "untouched for a week", and the ring is what closes that gap.
describe("unseen", () => {
  const unseenOf = async (id: string) => (await w.worktrees.rows()).find((x) => x.id === id)?.unseen;

  test("marking unread rings a row nothing has run in, and looking at it clears the mark", async () => {
    await registered();
    const main = w.state.worktrees.find((x) => x.kind === "main")!;
    w.turns.markUnread(main.id);
    expect(await unseenOf(main.id)).toBe(true);
    w.turns.markSeen(main.id);
    expect(await unseenOf(main.id)).toBeUndefined();
    expect(w.state.worktree(main.id)?.unread).toBeUndefined();
  });

  test("marking unread brings back a ring that looking had cleared", async () => {
    await registered();
    const main = w.state.worktrees.find((x) => x.kind === "main")!;
    w.hub.emit("agentStatus", main.id, "working");
    w.hub.emit("agentStatus", main.id, "idle");
    w.turns.markSeen(main.id);
    expect(await unseenOf(main.id)).toBeUndefined();
    w.turns.markUnread(main.id);
    expect(await unseenOf(main.id)).toBe(true);
  });

  test("a worktree nothing has run in is not unseen", async () => {
    await registered();
    const main = w.state.worktrees.find((x) => x.kind === "main")!;
    expect(await unseenOf(main.id)).toBeUndefined();
  });

  test("a turn ending marks it unseen, and marking it seen clears it", async () => {
    await registered();
    const main = w.state.worktrees.find((x) => x.kind === "main")!;
    w.hub.emit("agentStatus", main.id, "working");
    w.hub.emit("agentStatus", main.id, "idle");
    expect(await unseenOf(main.id)).toBe(true);
    // an agent finishing is not someone sending: the row keeps its place
    expect(w.state.worktree(main.id)?.promptedAt).toBeUndefined();
    w.turns.markSeen(main.id);
    expect(await unseenOf(main.id)).toBeUndefined();
  });

  test("a turn ending restarts a proc that crashed or never answered, and only those", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "fix it");
    await settle();
    const procs = w.procs.get(wt.id)!;
    const web = procs.states()[0]!;
    // the fake keeps live records under states(); flip one to what the supervisor would report
    (procs as unknown as { states_: (typeof web)[] }).states_[0]!.status = "unreachable";
    await procs.start("api", "true");
    w.hub.emit("agentStatus", wt.id, "working");
    w.hub.emit("agentStatus", wt.id, "idle");
    await settle();
    expect(procs.restarts).toEqual([web.name]);
    // an idle report with no turn before it restarts nothing
    w.hub.emit("agentStatus", wt.id, "idle");
    await settle();
    expect(procs.restarts).toEqual([web.name]);
  });

  test("a turn that ends after you looked rings it again", async () => {
    await registered();
    const main = w.state.worktrees.find((x) => x.kind === "main")!;
    w.hub.emit("agentStatus", main.id, "working");
    w.hub.emit("agentStatus", main.id, "idle");
    w.turns.markSeen(main.id);
    // the clock is coarse enough that a second turn inside the same millisecond would look seen
    w.state.worktree(main.id)!.seenAt = Date.now() - 1_000;
    w.hub.emit("agentStatus", main.id, "working");
    w.hub.emit("agentStatus", main.id, "idle");
    expect(await unseenOf(main.id)).toBe(true);
  });

  test("blocked on a person also counts as a turn ending", async () => {
    await registered();
    const main = w.state.worktrees.find((x) => x.kind === "main")!;
    w.hub.emit("agentStatus", main.id, "waiting");
    w.hub.emit("agentStatus", main.id, "idle");
    expect(await unseenOf(main.id)).toBe(true);
  });

  // a session reports idle when it is born; that is not a finished turn
  test("idle without a turn before it does not ring", async () => {
    await registered();
    const main = w.state.worktrees.find((x) => x.kind === "main")!;
    w.hub.emit("agentStatus", main.id, "idle");
    expect(await unseenOf(main.id)).toBeUndefined();
  });
});
