import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WorktreeInfo } from "@toyon/shared";
import { fakeAgents } from "../../test/helpers/fakes.ts";
import { world } from "../../test/helpers/world.ts";
import { UserError } from "../core/errors.ts";
import { stampAgent } from "../runtime/registry.ts";

// An agent's list is cached as it is learned, for the pickers, and holds no record to it: a record
// is a request, and the session applies it against the list of the agent that actually runs.
const record = (id: string, agent: string, model?: string, effort?: string): WorktreeInfo =>
  ({
    id,
    repoId: "r1",
    branch: id,
    path: `/nowhere/${id}`,
    port: 0,
    status: "idle",
    agent,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  }) as unknown as WorktreeInfo;

const before = [
  { id: "default", name: "Default (recommended)", description: "Opus (1M context)" },
  { id: "claude-fable-5-1[1m]", name: "Fable" },
];
const after = [
  { id: "default", name: "Default (recommended)", description: "Opus 5.5" },
  { id: "fable", name: "Fable 5.1" },
];

describe("an agent's learned list", () => {
  let w: ReturnType<typeof world>;
  beforeEach(() => {
    w = world();
  });
  afterEach(() => w.cleanup());

  test("is cached and announced once per change, and moves no record", () => {
    const heard: string[] = [];
    w.hub.on("agentsChanged", () => heard.push("agents"));
    w.hub.on("worktreesChanged", () => heard.push("worktrees"));
    w.state.addWorktree(record("a", "claude", "claude-fable-5-1[1m]", "high"));
    w.state.addWorktree(record("b", "claude", "haiku"));
    heard.length = 0;
    w.hub.emit("optionsLearned", "claude", "model", before, "default");
    w.hub.emit("optionsLearned", "claude", "model", after, "default");
    // the same list again says nothing
    w.hub.emit("optionsLearned", "claude", "model", after);
    expect(heard).toEqual(["agents", "agents"]);
    expect(w.state.cachedOptions("claude", "model").map((c) => c.id)).toEqual(["default", "fable"]);
    expect(w.state.worktrees.map((wt) => wt.model)).toEqual(["claude-fable-5-1[1m]", "haiku"]);
  });

  test("a set is taken as given, and the empty id clears", () => {
    w.state.addWorktree(record("a", "claude", "fable"));
    w.hub.emit("optionsLearned", "claude", "model", after, "default");
    w.worktrees.setModel("a", "claude-fable-5-1[1m]");
    expect(w.state.worktree("a")?.model).toBe("claude-fable-5-1[1m]");
    w.worktrees.setModel("a", "");
    expect(w.state.worktree("a")?.model).toBeUndefined();
  });
});

// What the composer picked for new worktrees of an agent lives on the daemon, per agent, so every
// create (a send, the setup view's, a found or opened branch, another shell's) stamps the same one.
describe("the picks for new worktrees", () => {
  let w: ReturnType<typeof world>;
  beforeEach(() => {
    w = world();
  });
  afterEach(async () => {
    await w.runtime.shutdown();
    w.cleanup();
  });

  test("the empty value clears a field, and the agent's entry with its last one", () => {
    w.state.setPick("claude", "model", "fable");
    w.state.setPick("claude", "effort", "high");
    expect(w.state.picks("claude")).toEqual({ model: "fable", effort: "high" });
    w.state.setPick("claude", "model", "");
    expect(w.state.picks("claude")).toEqual({ effort: "high" });
    w.state.setPick("claude", "effort", "");
    expect(w.state.picks("claude")).toEqual({});
    expect(w.state.picks("codex")).toEqual({});
  });

  test("a create stamps the picks of the agent it runs where it names none, and what it names wins", async () => {
    const repo = await w.repos.register(w.repo);
    repo.needsSetup = false;
    w.state.save();
    w.state.setPick("claude", "model", "fable");
    w.state.setPick("claude", "effort", "high");
    w.state.setPick("codex", "model", "gpt");
    const picked = await w.worktrees.create(repo.id, "task", { title: "Picked" });
    expect([picked.agent, picked.model, picked.effort]).toEqual(["claude", "fable", "high"]);
    const named = await w.worktrees.create(repo.id, "task", { title: "Named", model: "opus" });
    expect([named.model, named.effort]).toEqual(["opus", "high"]);
    const other = await w.worktrees.create(repo.id, "task", { title: "Other", agent: "codex" });
    expect([other.agent, other.model, other.effort]).toEqual(["codex", "gpt", undefined]);
  });

  test("a repo's picks fill the mode and profile a create leaves blank; a profile the file lost is left out", async () => {
    const repo = await w.repos.register(w.repo);
    repo.needsSetup = false;
    repo.config = {
      run: { web: "true", api: "true" },
      profiles: { full: { run: ["api", "web"] }, fe: { run: ["web"] } },
    };
    w.state.save();
    expect(() => w.state.setRepoPick(repo.id, "mode", "loud")).toThrow(UserError);
    expect(() => w.state.setRepoPick(repo.id, "profile", "nope")).toThrow(UserError);
    w.state.setRepoPick(repo.id, "mode", "ask");
    w.state.setRepoPick(repo.id, "profile", "fe");
    const picked = await w.worktrees.create(repo.id, "task", { title: "Picked" });
    expect([picked.mode, picked.profile]).toEqual(["ask", "fe"]);
    const named = await w.worktrees.create(repo.id, "task", { title: "Named", mode: "plan", profile: "full" });
    expect([named.mode, named.profile]).toEqual(["plan", "full"]);
    delete repo.config.profiles?.fe;
    const lost = await w.worktrees.create(repo.id, "task", { title: "Lost" });
    expect([lost.mode, lost.profile]).toEqual(["ask", undefined]);
    w.state.setRepoPick(repo.id, "mode", "");
    expect(w.state.requireRepo(repo.id).picks).toEqual({ profile: "fe" });
  });

  test("a pick is relisted against the agent's list as last learned: a renamed model is followed, a dropped one is left out", () => {
    w.state.setPick("claude", "model", "claude-fable-5-1[1m]");
    w.state.setPick("claude", "effort", "max");
    // nothing listed yet: taken as picked
    expect(w.state.fillPicks("claude", {})).toEqual({ model: "claude-fable-5-1[1m]", effort: "max" });
    w.hub.emit("optionsLearned", "claude", "model", after, "default");
    w.hub.emit("optionsLearned", "claude", "thought_level", [{ id: "high", name: "High" }], "high");
    expect(w.state.fillPicks("claude", {})).toEqual({ model: "fable" });
    // what the maker named is not relisted: a record is a request, and the session applies it
    expect(w.state.fillPicks("claude", { model: "haiku" })).toEqual({ model: "haiku" });
    w.state.setPick("claude", "model", "haiku");
    expect(w.state.fillPicks("claude", {})).toEqual({});
  });

  test("a row with no agent is stamped with the default and its picks on first use; a spare takes the agent alone", () => {
    const d = { state: w.state, agents: fakeAgents(w.paths.agentsDir), hub: w.hub };
    w.state.setPick("claude", "model", "fable");
    w.state.addWorktree(record("m", ""));
    w.state.addWorktree({ ...record("s", ""), kind: "spare" });
    expect(stampAgent("m", d).id).toBe("claude");
    expect(w.state.worktree("m")).toMatchObject({ agent: "claude", model: "fable" });
    stampAgent("s", d);
    expect(w.state.worktree("s")?.agent).toBe("claude");
    expect(w.state.worktree("s")?.model).toBeUndefined();
  });
});
