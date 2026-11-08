import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sh } from "../../test/helpers/tmp-repo.ts";
import { foreignWorktree, registered, settle, until, useWorld, w } from "../../test/helpers/world.ts";
import { OutsideSend } from "./outside.ts";

// `toyon send` from a terminal: the directory decides which row the message is for, the way the
// box the person types into does in the shell.

useWorld();

function door() {
  const told: string[] = [];
  const outside = new OutsideSend({
    state: w.state,
    register: (path) => w.repos.register(path),
    worktrees: {
      create: (repoId, prompt, opts) => w.worktrees.create(repoId, prompt, opts),
      adopt: (id, createdBy, message) => w.worktrees.adopt(id, createdBy, message),
      send: (id, msg) => w.worktrees.send(id, msg),
      discovered: () => w.worktrees.discovered(),
      invalidateDiscovered: () => w.worktrees.invalidateDiscovered(),
    },
    tell: (o) => {
      told.push(o.worktreeId);
      return told.length % 2 === 0;
    },
  });
  return { outside, told };
}

const FROM = "This message was sent from a terminal in";

describe("toyon send", () => {
  test("from a project's main checkout, a worktree starts with the message as its first, and the project registers on the way", async () => {
    const { outside, told } = door();
    expect(w.state.repos).toEqual([]);
    const reply = await outside.send({ path: w.repo, text: "make the header sticky", by: "Claude Code" });
    // registered by its real path, as `toyon <path>` registers one (git reads a symlinked /tmp through)
    expect(w.state.repos.map((r) => r.path)).toEqual([realpathSync(w.repo)]);
    expect(reply).toMatchObject({ kind: "worktree", delivered: false });
    expect(told).toEqual([reply.worktreeId]);
    const wt = w.state.worktree(reply.worktreeId)!;
    expect(wt.kind).toBe("worktree");
    expect(reply.title).toBe(wt.title);
    await until(() => (w.agents.get(wt.id)?.sent.length ?? 0) > 0);
    const sent = w.agents.get(wt.id)!.sent[0]!;
    expect(sent.text).toBe("make the header sticky");
    expect(
      sent.context?.some((c) => c.startsWith(FROM) && c.endsWith("with `toyon send`, where Claude Code was working.")),
    ).toBe(true);
  });

  test("a subdirectory of the checkout is the checkout; main's uncommitted files stay unless carried, and the reply counts them", async () => {
    await registered();
    await settle();
    const { outside } = door();
    const sub = join(w.repo, "lib");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "wip.txt"), "x\n");
    const stayed = await outside.send({ path: sub, text: "finish the lib" });
    expect(stayed).toMatchObject({ kind: "worktree", stayed: 1 });
    // the paragraph names where the person stood, not the root it resolved to
    await until(() => (w.agents.get(stayed.worktreeId)?.sent.length ?? 0) > 0);
    expect(w.agents.get(stayed.worktreeId)!.sent[0]!.context?.[0]).toBe(
      `${FROM} ${realpathSync(sub)} with \`toyon send\`.`,
    );
    expect(sh(w.repo, "git", "status", "--porcelain")).toContain("lib/");
    const carried = await outside.send({ path: sub, text: "carry the lib", carry: true });
    expect(carried.stayed).toBeUndefined();
    expect(sh(w.repo, "git", "status", "--porcelain")).toBe("");
  });

  test("from a worktree git made that Toyon does not run, it is taken over with the message as its first", async () => {
    await registered();
    await settle();
    const { outside } = door();
    const dir = foreignWorktree("theirs", "their-branch");
    const reply = await outside.send({ path: dir, text: "what is on this branch" });
    expect(reply).toMatchObject({ kind: "worktree", title: "their-branch" });
    const wt = w.state.worktree(reply.worktreeId)!;
    expect(wt).toMatchObject({ branch: "their-branch", parked: true });
    expect(await w.worktrees.discovered()).toEqual([]);
    const sent = w.agents.get(wt.id)!.sent[0]!;
    expect(sent.text).toBe("what is on this branch");
    expect(sent.context?.[0]).toStartWith(FROM);
  });

  test("from a worktree Toyon runs, the message goes into its chat", async () => {
    const repoId = await registered();
    await settle();
    const task = await w.worktrees.create(repoId, "first task");
    await settle();
    const { outside } = door();
    const reply = await outside.send({ path: task.path, text: "also fix the footer" });
    expect(reply).toEqual({ kind: "sent", worktreeId: task.id, title: task.title, delivered: false });
    const sent = w.agents.get(task.id)!.sent.at(-1)!;
    expect(sent.text).toBe("also fix the footer");
    expect(sent.context?.[0]).toStartWith(FROM);
    expect(w.state.worktrees.filter((x) => x.kind === "worktree")).toHaveLength(1);
  });

  test("a spare, a directory that is no repository, a missing one and a bare one are refused in words", async () => {
    const repoId = await registered();
    await w.worktrees.spare.ensure(repoId);
    const { outside } = door();
    const spare = w.state.worktrees.find((x) => x.kind === "spare");
    expect(spare).toBeDefined();
    await expect(outside.send({ path: spare!.path, text: "hi" })).rejects.toThrow(
      "nothing is working in that directory yet",
    );
    const plain = join(dirname(w.repo), "plain");
    mkdirSync(plain, { recursive: true });
    await expect(outside.send({ path: plain, text: "hi" })).rejects.toThrow("not inside a git repository");
    await expect(outside.send({ path: join(plain, "gone"), text: "hi" })).rejects.toThrow("is not a directory");
    const bare = join(dirname(w.repo), "bare.git");
    sh(dirname(w.repo), "git", "init", "-q", "--bare", bare);
    await expect(outside.send({ path: bare, text: "hi" })).rejects.toThrow("a bare repository");
    await expect(outside.send({ path: w.repo, text: "   " })).rejects.toThrow("the message is empty");
  });
});
