import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, RepoInfo } from "@toyon/shared";
import type { FakeAgent } from "../../test/helpers/fakes.ts";
import { sh } from "../../test/helpers/tmp-repo.ts";
import { registered, settle, until, useWorld, w } from "../../test/helpers/world.ts";
import { Transcript, transcriptPathFor } from "../agent/transcript.ts";
import { UserError } from "../core/errors.ts";
import { GIT } from "../git/exec.ts";

// A handoff between two projects open in one daemon: the tool's answers to the agent, the card's
// state on the origin's transcript, the worktree Go makes in the other project, and the word back
// when it lands.

useWorld();

/** other projects made for a test, taken down with it */
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** a second project open beside the world's own, under a name of the test's choosing (the
 * world's is `repo`, which is a checkout's directory name like any other) */
async function otherProject(name: string): Promise<RepoInfo> {
  const root = mkdtempSync(join(tmpdir(), "toyon-handoff-"));
  made.push(root);
  const dir = join(root, name);
  sh(root, GIT, "init", "-q", "-b", "main", dir);
  sh(dir, GIT, "config", "user.email", "t@t");
  sh(dir, GIT, "config", "user.name", "t");
  sh(dir, GIT, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), `${name}\n`);
  sh(dir, GIT, "add", "-A");
  sh(dir, GIT, "commit", "-q", "-m", "init");
  const repo = await w.repos.register(dir);
  repo.needsSetup = false;
  repo.config = { run: { web: "true" } };
  w.state.save();
  return repo;
}

const agentOf = (id: string) => w.runtime.agentFor(id) as FakeAgent;
const recorded = (id: string, type: AgentEvent["type"]) => agentOf(id).recorded.filter((e) => e.type === type);
const lastProposal = (id: string) =>
  agentOf(id).recorded.findLast((e) => e.type === "handoff-proposed") as Extract<
    AgentEvent,
    { type: "handoff-proposed" }
  >;
const FINISH = "Proposed to the person as a card; they decide. Finish your turn.";

describe("resolve", () => {
  test("a name, in any case or as a unique prefix, or a path; never the worktree's own project", async () => {
    const repoId = await registered();
    const acp = await otherProject("claude-agent-acp");
    const mono = await otherProject("toyon-mono");
    const wt = await w.worktrees.create(repoId, "task");
    expect(
      w.handoff
        .targets(wt.id)
        .map((r) => r.name)
        .sort(),
    ).toEqual(["claude-agent-acp", "toyon-mono"]);
    expect(w.handoff.resolve(wt.id, "claude-agent-acp")).toEqual({ repo: acp });
    expect(w.handoff.resolve(wt.id, "Claude-Agent-ACP")).toEqual({ repo: acp });
    expect(w.handoff.resolve(wt.id, "toyon-m")).toEqual({ repo: mono });
    expect(w.handoff.resolve(wt.id, mono.path)).toEqual({ repo: mono });
    expect(w.handoff.resolve(wt.id, "repo")).toEqual({
      refused:
        "repo is this worktree's own project; a handoff goes to another one. Open projects: claude-agent-acp, toyon-mono.",
    });
    expect(w.handoff.resolve(wt.id, "nothing")).toEqual({
      refused: 'No open project is called "nothing". Open projects: claude-agent-acp, toyon-mono.',
    });
    expect(w.handoff.resolve(wt.id, "  ")).toEqual({
      refused: "Name the project to continue in. Open projects: claude-agent-acp, toyon-mono.",
    });
  });

  test("two open projects of one name are told apart by path, and the refusal names both", async () => {
    const repoId = await registered();
    const a = await otherProject("app");
    const b = await otherProject("app");
    const wt = await w.worktrees.create(repoId, "task");
    expect(w.handoff.resolve(wt.id, "app")).toEqual({
      refused: `"app" names more than one open project: ${a.path}, ${b.path}. Say which by its path.`,
    });
    expect(w.handoff.resolve(wt.id, b.path)).toEqual({ repo: b });
  });

  test("with no other project open there is nothing to hand off to, and the tool says so", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "task");
    expect(w.handoff.resolve(wt.id, "anything")).toEqual({
      refused: "No other project is open in Toyon, so there is nothing to hand off to.",
    });
    expect(w.handoff.tool(wt.id).description).toContain("No other project is open right now.");
  });
});

describe("propose", () => {
  test("the tool lists the projects it can name, and a call records the card with who asked, the mode and the path", async () => {
    const repoId = await registered();
    const acp = await otherProject("claude-agent-acp");
    const wt = await w.worktrees.create(repoId, "task", { mode: "ask" });
    const tool = w.handoff.tool(wt.id);
    expect(tool.name).toBe("handoff");
    expect(tool.description).toContain("Open projects you can name: claude-agent-acp.");
    expect(tool.inputSchema).toMatchObject({ required: ["project", "message"], additionalProperties: false });
    const r = await w.handoff.call(wt.id, {
      project: "claude-agent-acp",
      message: "  Fix the form field.  ",
      title: "Fix the form",
    });
    expect(r).toEqual({ text: FINISH });
    const p = lastProposal(wt.id);
    expect(p).toMatchObject({
      repo: { id: acp.id, name: "claude-agent-acp", path: acp.path },
      message: "Fix the form field.",
      title: "Fix the form",
      by: "agent",
      mode: "ask",
    });
    expect(p.id).toMatch(/^[0-9a-f-]{36}$/);
    // the fake's status does not move; the real session's does (session.test.ts)
  });

  test("the shape is checked, and the caps and the empty message are tool errors", async () => {
    const repoId = await registered();
    await otherProject("acp");
    const wt = await w.worktrees.create(repoId, "task");
    expect(await w.handoff.call(wt.id, { project: 1, message: "m" })).toEqual({
      text: "handoff takes { project: string, message: string, title?: string }.",
      isError: true,
    });
    expect(await w.handoff.call(wt.id, { project: "acp", message: "   " })).toEqual({
      text: "Write the message the other project's agent should start from.",
      isError: true,
    });
    expect(await w.handoff.call(wt.id, { project: "acp", message: "x".repeat(20_001) })).toMatchObject({
      text: expect.stringContaining("over 20000 characters"),
      isError: true,
    });
    expect(await w.handoff.call(wt.id, { project: "acp", message: "m", title: "t".repeat(201) })).toMatchObject({
      text: expect.stringContaining("over 200 characters"),
      isError: true,
    });
    expect(await w.handoff.call(wt.id, { project: "nope", message: "m" })).toEqual({
      text: 'No open project is called "nope". Open projects: acp.',
      isError: true,
    });
    expect(recorded(wt.id, "handoff-proposed")).toHaveLength(0);
  });

  test("one open card per chat, and three proposals per turn whatever became of them", async () => {
    const repoId = await registered();
    await otherProject("acp");
    const wt = await w.worktrees.create(repoId, "task");
    const agent = agentOf(wt.id);
    agent.note({ type: "turn-start", ts: 1 });
    const call = () => w.handoff.call(wt.id, { project: "acp", message: "m" });
    expect(await call()).toEqual({ text: FINISH });
    expect(await call()).toEqual({
      text: "A handoff is already waiting for the person on this chat; finish your turn.",
      isError: true,
    });
    await w.handoff.answer(wt.id, lastProposal(wt.id).id, false);
    expect(await call()).toEqual({ text: FINISH });
    await w.handoff.answer(wt.id, lastProposal(wt.id).id, false);
    expect(await call()).toEqual({ text: FINISH });
    await w.handoff.answer(wt.id, lastProposal(wt.id).id, false);
    expect(await call()).toEqual({
      text: "Three handoffs were proposed this turn already; finish your turn and let the person answer.",
      isError: true,
    });
    // the next turn starts the count again
    agent.note({ type: "turn-start", ts: 2 });
    expect(await call()).toEqual({ text: FINISH });
    expect(recorded(wt.id, "handoff-proposed")).toHaveLength(4);
  });
});

describe("answer", () => {
  test("Go makes the worktree in the other project from the message, the note and the pointer, and records where it went", async () => {
    const repoId = await registered();
    const acp = await otherProject("claude-agent-acp");
    const a = await w.worktrees.create(repoId, "task", { mode: "ask" });
    await w.handoff.call(a.id, {
      project: "claude-agent-acp",
      message: "Fix the form field.",
      title: "Fix the form",
    });
    const id = lastProposal(a.id).id;
    await w.handoff.answer(a.id, id, true, "  and add a test  ");
    const b = w.state.worktrees.find((x) => x.repoId === acp.id && x.kind === "worktree")!;
    expect(b).toBeDefined();
    expect(b).toMatchObject({
      title: "Fix the form",
      mode: "ask",
      from: { kind: "worktree", ref: a.branch, origin: { id: a.id, repoId } },
    });
    expect(b.unnamed).toBeUndefined();
    expect(b.createdBy).toBeUndefined();
    const first = agentOf(b.id).sent[0]!.text;
    expect(
      first.startsWith("Fix the form field.\n\nThe person added, when they approved this: and add a test\n\n"),
    ).toBe(true);
    expect(first).toContain(`handed off from the worktree at ${a.path} of the project repo, on its branch ${a.branch}`);
    expect(first).toContain("written by that worktree's agent");
    expect(agentOf(a.id).recorded.at(-1)).toMatchObject({
      type: "handoff",
      id,
      worktreeId: b.id,
      repoId: acp.id,
      repoName: "claude-agent-acp",
      title: "Fix the form",
    });
    // the other project's rows, where the person opens it, show it as a plain row
    expect((await w.worktrees.rows()).some((r) => r.id === b.id)).toBe(true);
  });

  test("Not now records the decline; a second answer is a no-op and an unknown card a refusal", async () => {
    const repoId = await registered();
    await otherProject("acp");
    const a = await w.worktrees.create(repoId, "task");
    await w.handoff.call(a.id, { project: "acp", message: "m" });
    const id = lastProposal(a.id).id;
    await w.handoff.answer(a.id, id, false);
    expect(agentOf(a.id).recorded.at(-1)).toMatchObject({ type: "handoff-declined", id });
    expect(agentOf(a.id).recorded.at(-1)).not.toHaveProperty("outcome");
    // the other tab's press lands on a closed card: nothing happens, nothing is made
    await w.handoff.answer(a.id, id, true);
    expect(recorded(a.id, "handoff")).toHaveLength(0);
    expect(w.state.worktrees.filter((x) => x.kind === "worktree")).toHaveLength(1);
    await expect(w.handoff.answer(a.id, "nope", true)).rejects.toThrow("That card is not in this chat");
    await expect(w.handoff.answer("nope", id, true)).rejects.toBeInstanceOf(UserError);
  });

  test("a Go that cannot make the worktree closes the card as failed on every tab and tells the pressing one", async () => {
    const repoId = await registered();
    const acp = await otherProject("acp");
    const a = await w.worktrees.create(repoId, "task");
    await w.handoff.call(a.id, { project: "acp", message: "m" });
    const id = lastProposal(a.id).id;
    // the other project is forgotten between the card and the press
    await w.repos.forget(acp.id);
    await expect(w.handoff.answer(a.id, id, true)).rejects.toThrow("acp is no longer open in Toyon");
    expect(agentOf(a.id).recorded.at(-1)).toMatchObject({
      type: "handoff-declined",
      id,
      outcome: "failed",
      reason: "acp is no longer open in Toyon",
    });
  });

  test("an answer after a restart resolves from the transcript on disk", async () => {
    const repoId = await registered();
    await otherProject("acp");
    const a = await w.worktrees.create(repoId, "task");
    await w.handoff.call(a.id, { project: "acp", message: "m" });
    const id = lastProposal(a.id).id;
    // the fake keeps its events in memory; a restart reads them back off the file the real
    // session would have written, through the same transcript reader
    const path = transcriptPathFor(w.paths.transcriptsDir, a.id);
    const log = new Transcript(path, a.id);
    for (const e of agentOf(a.id).recorded) log.append(e);
    await log.flush();
    const back = new Transcript(path, a.id);
    expect(back.entries.map((e) => e.event.type)).toContain("handoff-proposed");
    agentOf(a.id).recorded = back.entries.map((e) => e.event);
    await w.handoff.answer(a.id, id, false);
    expect(agentOf(a.id).recorded.at(-1)).toMatchObject({ type: "handoff-declined", id });
  });
});

describe("ask", () => {
  test("with the tool in hand the agent is asked to propose it, by path, with the person's words", async () => {
    const repoId = await registered();
    const acp = await otherProject("acp");
    const a = await w.worktrees.create(repoId, "task");
    const agent = agentOf(a.id);
    agent.mcpTools = true;
    await w.handoff.ask(a.id, acp.id, "fix the form");
    const sent = agent.sent.at(-1)!;
    expect(sent.asked).toEqual({ kind: "handoff", why: "continue in acp" });
    expect(sent.text).toContain(`project "${acp.path}"`);
    expect(sent.text).toContain("The user's own words for what acp should do: fix the form");
    expect(recorded(a.id, "handoff-proposed")).toHaveLength(0);
  });

  test("without the tool the card is raised from the person's words, and empty words are refused", async () => {
    const repoId = await registered();
    const acp = await otherProject("acp");
    const a = await w.worktrees.create(repoId, "task");
    const agent = agentOf(a.id);
    agent.mcpTools = false;
    await expect(w.handoff.ask(a.id, acp.id, "  ")).rejects.toThrow("Write what acp should do first");
    await w.handoff.ask(a.id, acp.id, "fix the form");
    expect(lastProposal(a.id)).toMatchObject({ repo: { id: acp.id }, message: "fix the form", by: "person" });
    expect(agent.sent.filter((s) => s.asked)).toHaveLength(0);
    // a second ask while the card stands is the tool's refusal, in the person's words
    await expect(w.handoff.ask(a.id, acp.id, "again")).rejects.toThrow("A handoff is already waiting");
  });

  test("an agent whose process is down is warmed first, so the answer is the live one", async () => {
    const repoId = await registered();
    const acp = await otherProject("acp");
    const a = await w.worktrees.create(repoId, "task");
    const agent = agentOf(a.id);
    expect(agent.mcpTools).toBeNull();
    agent.warmedTools = true;
    await w.handoff.ask(a.id, acp.id);
    expect(agent.warms).toBe(1);
    expect(agent.sent.at(-1)!.asked).toEqual({ kind: "handoff", why: "continue in acp" });
  });

  test("the worktree's own project and an unknown one are refused", async () => {
    const repoId = await registered();
    const a = await w.worktrees.create(repoId, "task");
    await expect(w.handoff.ask(a.id, repoId, "x")).rejects.toThrow("repo is this worktree's own project");
    await expect(w.handoff.ask(a.id, "nope", "x")).rejects.toThrow("no such project");
  });
});

describe("landed", () => {
  const paired = async () => {
    const repoId = await registered();
    const acp = await otherProject("acp");
    const a = await w.worktrees.create(repoId, "task");
    await w.handoff.call(a.id, { project: "acp", message: "m", title: "Fix it" });
    await w.handoff.answer(a.id, lastProposal(a.id).id, true);
    const b = w.state.worktrees.find((x) => x.repoId === acp.id && x.kind === "worktree")!;
    return { a, b, acp };
  };

  test("the made worktree landing tells the origin, with the PR when the landing was one", async () => {
    const { a, b } = await paired();
    w.worktrees.setPr(b.id, { number: 7, url: "https://x/pull/7", state: "merged", at: 1 });
    w.hub.emit("landed", b.id);
    expect(agentOf(a.id).recorded.at(-1)).toEqual({
      type: "handoff-landed",
      worktreeId: b.id,
      repoName: "acp",
      title: "Fix it",
      url: "https://x/pull/7",
      ts: expect.any(Number),
    });
    // a real land, through the service, reaches it the same way
    writeFileSync(join(b.path, "feature.txt"), "x\n");
    expect((await w.worktrees.commit(b.id, "add feature")).ok).toBe(true);
    w.worktrees.setPr(b.id, undefined);
    expect((await w.worktrees.land(b.id)).result.ok).toBe(true);
    expect(recorded(a.id, "handoff-landed")).toHaveLength(2);
    expect(agentOf(a.id).recorded.at(-1)).not.toHaveProperty("url");
  });

  test("nothing when the origin is gone, and nothing for a worktree no handoff made", async () => {
    const { a, b } = await paired();
    await w.worktrees.discardWorktree(a.id);
    await until(() => !w.state.worktree(a.id));
    await settle();
    const before = w.agents.size;
    w.hub.emit("landed", b.id);
    expect(w.agents.size).toBe(before);
    const plain = await w.worktrees.create(b.repoId, "own task");
    w.hub.emit("landed", plain.id);
    expect(recorded(plain.id, "handoff-landed")).toHaveLength(0);
  });
});
