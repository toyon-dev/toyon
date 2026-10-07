import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SHELL_TOOL } from "@toyon/shared";
import type { FakeAgent } from "../../test/helpers/fakes.ts";
import { sh } from "../../test/helpers/tmp-repo.ts";
import { counted, registered, setRoute, until, useWorld, w } from "../../test/helpers/world.ts";
import { fixPrompt } from "../agent/prompt.ts";
import { UserError } from "../core/errors.ts";
import { GIT, git } from "../git/exec.ts";
import { CARRIED } from "../git/land.ts";
import { treeFingerprint } from "../git/status.ts";

// Landing on the merge route: the commit, the sync, the verdict on the tree it saw, and the hooks in the way.

useWorld();

describe("landing", () => {
  /** the subjects on main, newest first */
  const subjects = async () => (await git(w.repo, "log", "--format=%s", "-n", "6")).out.split("\n");
  /** how many parents main's tip has: two for a merge commit, one otherwise */
  const parents = async () => (await git(w.repo, "log", "-1", "--format=%P")).out.split(" ").filter(Boolean).length;

  test("a committed branch lands under a merge commit, marks landed, and restarts from main; an edit unmarks it until discarded", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    expect((await w.worktrees.commit(wt.id, "add feature")).ok).toBe(true);
    const landedIds: string[] = [];
    w.hub.on("landed", (id) => landedIds.push(id));
    const { result, archiveIds } = await w.worktrees.land(wt.id);
    expect(result.ok).toBe(true);
    expect(archiveIds).toEqual([]);
    // the hub hears of it too, after the row's own word, for a worktree that handed this work off
    expect(landedIds).toEqual([wt.id]);
    // the word on it goes on the transcript, where a reload reads it back
    expect(w.agents.get(wt.id)!.recorded.at(-1)).toMatchObject({
      type: "landed",
      message: "merged into main",
      archiveIds: [],
    });
    expect(existsSync(join(w.repo, "feature.txt"))).toBe(true);
    expect(await parents()).toBe(2);
    expect((await git(w.repo, "log", "-1", "--format=%s", "main^2")).out).toBe("add feature");
    expect(w.state.worktree(wt.id)?.landed).toBe(true);
    // the branch now equals main: nothing ahead, nothing behind, a clean base for what comes next
    expect((await git(wt.path, "rev-parse", "HEAD")).out).toBe((await git(w.repo, "rev-parse", "main")).out);
    // an edit clears the mark through gitStatus, and discarding it brings the mark back: the
    // base has the work either way, and only what is here says whether there is more
    writeFileSync(join(wt.path, "more.txt"), "y\n");
    await w.worktrees.gitStatus(wt.id);
    expect(w.state.worktree(wt.id)?.landed).toBeUndefined();
    rmSync(join(wt.path, "more.txt"));
    await w.worktrees.gitStatus(wt.id);
    expect(w.state.worktree(wt.id)?.landed).toBe(true);
    // a commit past the landing is new work, and the mark is gone for good
    writeFileSync(join(wt.path, "more.txt"), "y\n");
    expect((await w.worktrees.commit(wt.id, "more")).ok).toBe(true);
    await w.worktrees.gitStatus(wt.id);
    expect(w.state.worktree(wt.id)?.landed).toBeUndefined();
  });

  test("a commit by hand keeps the verdict on the tree it saw, without the message that is in git now", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    const row = w.state.worktree(wt.id)!;
    row.landing = {
      at: 1,
      check: "pass",
      ready: true,
      why: "a question is open",
      subject: "add feature",
      body: "One file.",
      fingerprint: await treeFingerprint(wt.path),
    };
    expect((await w.worktrees.commit(wt.id, "add feature")).ok).toBe(true);
    await w.worktrees.gitStatus(wt.id);
    expect(row.landing).toEqual({
      at: 1,
      check: "pass",
      ready: true,
      why: "a question is open",
      fingerprint: await treeFingerprint(wt.path),
    });
    // an edit after the commit is a tree the verdict never saw
    writeFileSync(join(wt.path, "more.txt"), "y\n");
    await w.worktrees.gitStatus(wt.id);
    expect(row.landing?.stale).toBe(true);
  });

  test("a sync keeps the verdict, message and all: the same work over a newer base", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    expect((await w.worktrees.commit(wt.id, "add feature")).ok).toBe(true);
    const row = w.state.worktree(wt.id)!;
    row.landing = {
      at: 1,
      check: "pass",
      ready: true,
      subject: "add feature",
      body: "One file.",
      fingerprint: await treeFingerprint(wt.path),
    };
    writeFileSync(join(w.repo, "other.txt"), "o\n");
    sh(w.repo, GIT, "add", "-A");
    sh(w.repo, GIT, "commit", "-qm", "other");
    expect((await w.worktrees.sync(wt.id)).result.ok).toBe(true);
    await w.worktrees.gitStatus(wt.id);
    expect(row.landing).toEqual({
      at: 1,
      check: "pass",
      ready: true,
      subject: "add feature",
      body: "One file.",
      fingerprint: await treeFingerprint(wt.path),
    });
  });

  test("a landing git did without toyon marks the row landed, keeps the range, and restarts the branch", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    const before = (await git(w.repo, "rev-parse", "main")).out;
    // a row that only answered has no commits of its own: not a landing
    await w.worktrees.gitStatus(wt.id);
    expect(w.state.worktree(wt.id)?.landed).toBeUndefined();
    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    expect((await w.worktrees.commit(wt.id, "add feature")).ok).toBe(true);
    const tip = (await git(wt.path, "rev-parse", "HEAD")).out;
    await w.worktrees.gitStatus(wt.id);
    expect(w.state.worktree(wt.id)?.landed).toBeUndefined();
    // the agent fast-forwards main from the main checkout
    expect((await git(w.repo, "merge", "--ff-only", wt.branch)).ok).toBe(true);
    expect(await w.worktrees.gitStatus(wt.id)).toMatchObject({ files: [], ahead: 0, behind: 0 });
    const row = w.state.worktree(wt.id)!;
    expect(row.landed).toBe(true);
    expect(row.lands).toEqual([{ base: before, tip, at: expect.any(Number) }]);
    expect((await git(w.repo, "rev-parse", `refs/toyon/lands/${wt.id}/0`)).out).toBe(tip);
    // a second landing, under a merge commit this time, counts only the commits after the first
    writeFileSync(join(wt.path, "more.txt"), "y\n");
    expect((await w.worktrees.commit(wt.id, "more")).ok).toBe(true);
    await w.worktrees.gitStatus(wt.id);
    expect(row.landed).toBeUndefined();
    const second = (await git(wt.path, "rev-parse", "HEAD")).out;
    expect((await git(w.repo, "merge", "--no-ff", "-m", "land more", wt.branch)).ok).toBe(true);
    await w.worktrees.gitStatus(wt.id);
    expect(row.landed).toBe(true);
    expect(row.lands?.[1]).toMatchObject({ base: tip, tip: second });
    // restarted from main: level with the merge commit, as after the press
    expect((await git(wt.path, "rev-parse", "HEAD")).out).toBe((await git(w.repo, "rev-parse", "main")).out);
  });

  test("commits reset away by hand are not a landing", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    expect((await w.worktrees.commit(wt.id, "add feature")).ok).toBe(true);
    expect((await git(wt.path, "reset", "--hard", "main")).ok).toBe(true);
    await w.worktrees.gitStatus(wt.id);
    expect(w.state.worktree(wt.id)?.landed).toBeUndefined();
  });

  /** a pre-commit hook for the repo that prints its complaint and refuses; repo-local hooksPath so
   * a global one on this machine does not stand in for it */
  const refusingHook = (lines: string[], hook = "pre-commit") => {
    // beside the checkout, not in it: an untracked hooks folder would dirty main and stop a landing
    const hooks = join(w.repo, "..", "hooks");
    mkdirSync(hooks, { recursive: true });
    const body = lines.map((l) => `echo ${JSON.stringify(l)}`).join("\n");
    writeFileSync(join(hooks, hook), `#!/bin/sh\n${body}\necho "and on stderr" 1>&2\nexit 1\n`, {
      mode: 0o755,
    });
    sh(w.repo, "git", "config", "core.hooksPath", hooks);
  };
  const recorded = (id: string) => (w.runtime.agentFor(id) as unknown as FakeAgent).recorded;
  /** what the agent was sent after the message that made the worktree, and its words alone */
  const sent = (id: string) =>
    (w.runtime.agentFor(id) as unknown as FakeAgent).sent.slice(1).map(({ text, asked }) => ({ text, asked }));
  const asked = (id: string) => sent(id).map((m) => m.text);
  /** what Toyon attached behind its last message: the failed command and what it printed */
  const shown = (id: string) => (w.runtime.agentFor(id) as unknown as FakeAgent).sent.at(-1)?.context;
  /** a failed command for a prompt that only names it: the row and the output are not in its words */
  const ran = (command = "") => ({ toolId: "t", command, text: "" });
  const row = expect.any(String);

  test("a commit git itself refuses asks nobody; a hook's refusal is the agent's, as Toyon's own message", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    const before = w.state.worktree(wt.id)?.promptedAt;
    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    // no hook here: an index someone else holds is git's own refusal, with nothing to fix
    const lock = join((await git(wt.path, "rev-parse", "--absolute-git-dir")).out, "index.lock");
    writeFileSync(lock, "");
    const plain = await w.worktrees.commit(wt.id, "add feature");
    expect(plain.ok).toBe(false);
    expect(plain.asked).toBeUndefined();
    expect(asked(wt.id)).toEqual([]);
    rmSync(lock);
    refusingHook(["one file rejected"]);
    const refused = await w.worktrees.commit(wt.id, "add feature");
    expect(refused.asked).toBe(true);
    expect(sent(wt.id)).toEqual([
      {
        text: fixPrompt({ kind: "hook", hook: "pre-commit", ...ran() }),
        asked: { kind: "hook", why: "the pre-commit hook refused the commit", toolId: row },
      },
    ]);
    // not the person's send: the rail sorts on theirs
    expect(w.state.worktree(wt.id)?.promptedAt).toBe(before);
  });

  test("a commit-msg hook's refusal is answered with a new message, not a turn", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    refusingHook(["subject over 72 characters"], "commit-msg");
    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    const result = await w.worktrees.commit(wt.id, "add feature");
    expect(result).toMatchObject({
      ok: false,
      message: "the commit-msg hook refused the message: another is being written",
    });
    expect(result.asked).toBeUndefined();
    expect(asked(wt.id)).toEqual([]);
    expect(w.refused).toEqual([[wt.id, "subject over 72 characters\nand on stderr"]]);
  });

  test("a failed check is the agent's to fix once, until a message that is not that ask", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    const agent = w.runtime.agentFor(wt.id) as unknown as FakeAgent;
    // a fake records no turns, so each message is put on its transcript the way a session would
    const heard = () => {
      const m = agent.sent.at(-1)!;
      agent.note(
        m.asked
          ? { type: "fix-asked", text: m.text, ts: 1, ...m.asked }
          : { type: "user-message", text: m.text, ts: 1 },
      );
    };
    const check = fixPrompt({ kind: "check", ...ran("bun run check") });
    const failed = (n: number) => ({ toolId: `check-${n}`, command: "bun run check", text: `${n} errors\n` });
    w.hub.emit("checkFailed", wt.id, failed(1));
    expect(sent(wt.id)).toEqual([
      { text: check, asked: { kind: "check", why: "the check failed", toolId: "check-1" } },
    ]);
    // what the check printed goes with the message: nothing else puts it in front of the agent
    expect(shown(wt.id)).toEqual(["What Toyon ran, and what it printed:\n$ bun run check\n1 errors"]);
    heard();
    // the fix turn ends in the same check: a second failure waits for the person
    w.hub.emit("checkFailed", wt.id, failed(2));
    expect(asked(wt.id)).toEqual([check]);
    await w.worktrees.send(wt.id, { text: "try the other way" });
    heard();
    w.hub.emit("checkFailed", wt.id, failed(3));
    expect(asked(wt.id)).toEqual([check, "try the other way", check]);
  });

  test("the boot pane's fix is the agent's, with the daemon's own diagnosis", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    await w.worktrees.fixPreview(wt.id);
    expect(sent(wt.id)).toEqual([
      {
        text: expect.stringContaining("The dev server in this worktree is not reachable"),
        asked: { kind: "preview", why: "the dev server is not reachable" },
      },
    ]);
  });

  test("a commit a hook refuses goes on the transcript whole, as the rows a ! command leaves", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    refusingHook(["a dash in copy: src/x.ts:3", "one file rejected"]);
    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    const result = await w.worktrees.commit(wt.id, "add feature\n\nwith a body");
    expect(result.ok).toBe(false);
    expect(result.message).toBe("commit refused: what git and its hooks printed is on the chat");
    // the hook's output is on the transcript, so the turn that fixes it is sent, not left to type
    expect(result.asked).toBe(true);
    expect(asked(wt.id)).toEqual([fixPrompt({ kind: "hook", hook: "pre-commit", ...ran() })]);
    // and the agent is shown what the hook printed, attached behind the message that asks
    expect(shown(wt.id)).toEqual([
      'What Toyon ran, and what it printed:\n$ git commit -m "add feature"\na dash in copy: src/x.ts:3\none file rejected\nand on stderr',
    ]);
    const rows = recorded(wt.id);
    expect(rows.map((e) => e.type)).toEqual(["tool-start", "tool-end"]);
    const start = rows[0];
    expect(start?.type === "tool-start" && start.name === SHELL_TOOL && start.input).toEqual({
      command: 'git commit -m "add feature"',
    });
    const end = rows[1];
    expect(end?.type === "tool-end" && end.isError).toBe(true);
    expect(end?.type === "tool-end" && end.fixable).toEqual({ kind: "hook", hook: "pre-commit" });
    expect(end?.type === "tool-end" && end.output).toBe(
      "```\na dash in copy: src/x.ts:3\none file rejected\nand on stderr\n```\nexit 1",
    );
    // land's commit step is the same commit: refused the same way, and nothing lands
    const landed = await w.worktrees.land(wt.id, "add feature");
    expect(landed.result.ok).toBe(false);
    expect(recorded(wt.id).map((e) => e.type)).toEqual(["tool-start", "tool-end", "tool-start", "tool-end"]);
    expect(existsSync(join(w.repo, "feature.txt"))).toBe(false);
  });

  test("a push a pre-push hook refuses goes on the transcript whole, named for the checkout it ran in", async () => {
    const repoId = await registered();
    const origin = join(w.repo, "..", "origin.git");
    sh(w.repo, "git", "init", "-q", "--bare", "-b", "main", origin);
    sh(w.repo, "git", "remote", "add", "origin", origin);
    sh(w.repo, "git", "push", "-q", "-u", "origin", "main");
    await setRoute(repoId, "push");
    refusingHook(["tests: 1 failed"], "pre-push");
    const wt = await w.worktrees.create(repoId, "feature");
    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    const { result } = await w.worktrees.land(wt.id, "add feature");
    expect(result.ok).toBe(false);
    expect(result.message).toBe("push failed: what git and its hooks printed is on the chat");
    expect(sent(wt.id)).toEqual([
      {
        text: fixPrompt({ kind: "hook", hook: "pre-push", ...ran() }),
        asked: { kind: "hook", why: "the pre-push hook refused the push", toolId: row },
      },
    ]);
    const rows = recorded(wt.id);
    expect(rows.map((e) => e.type)).toEqual(["tool-start", "tool-end"]);
    // the push runs in the worktree, so its row is the plain command
    const start = rows[0];
    expect(start?.type === "tool-start" && start.input).toEqual({
      command: expect.stringMatching(/^git push origin [0-9a-f]{40}:refs\/heads\/main$/),
    });
    const end = rows[1];
    expect(end?.type === "tool-end" && end.isError).toBe(true);
    expect(end?.type === "tool-end" && end.output).toContain("tests: 1 failed\nand on stderr\n");
    expect(end?.type === "tool-end" && end.output).toContain("exit 1");
    // nothing landed: origin has nothing of it, and the work stands committed on the branch
    expect(w.state.worktree(wt.id)?.landed).toBeUndefined();
    expect((await git(origin, "log", "-1", "--format=%s", "main")).out).toBe("init");
    expect(await w.worktrees.gitStatus(wt.id)).toMatchObject({ files: [], ahead: 1 });
  });

  test("the press is the op out on the row, named step by step, with the agent's queue held", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    const agent = w.runtime.agentFor(wt.id) as unknown as FakeAgent;
    // what each frame would carry, and whether the queue was held when it went out
    const seen: Array<{ step?: string; held: boolean }> = [];
    w.hub.on("worktreesChanged", () => {
      const out = w.worktrees.shippingOf(wt.id);
      const last = seen.at(-1);
      if (out && (!last || last.step !== out.step)) seen.push({ step: out.step, held: agent.held });
    });
    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    sh(w.repo, "git", "commit", "-q", "--allow-empty", "-m", "main moved");
    const landing = w.worktrees.land(wt.id, "add feature");
    // one op per row: a second press meanwhile is refused, whichever tab it came from
    await expect(w.worktrees.commit(wt.id, "again")).rejects.toThrow("a land is already running here");
    expect((await landing).result.ok).toBe(true);
    expect(seen).toEqual([
      { step: undefined, held: true },
      { step: "committing", held: true },
      { step: "rebasing onto main", held: true },
      { step: "merging into main", held: true },
    ]);
    // over: off the frame, and the queue goes again
    expect(w.worktrees.shippingOf(wt.id)).toBeUndefined();
    expect(agent.held).toBe(false);
    expect((await w.worktrees.rows()).find((r) => r.id === wt.id)?.shipping).toBeUndefined();
    // steps that passed at once left no rows behind: the transcript holds the word on the land alone
    expect(recorded(wt.id).map((e) => e.type)).toEqual(["landed"]);
  });

  test("the verdict goes and the landed mark comes in one frame, so no frame reads as work unchecked", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    w.worktrees.setLanding(wt.id, { at: 1, check: "none", ready: true, subject: "add feature", fingerprint: "f" });
    // what each frame would carry of the record
    const seen: Array<{ verdict: boolean; landed: boolean }> = [];
    w.hub.on("worktreesChanged", () => {
      const r = w.state.worktree(wt.id);
      seen.push({ verdict: !!r?.landing, landed: !!r?.landed });
    });
    expect((await w.worktrees.land(wt.id)).result.ok).toBe(true);
    expect(seen.filter((f) => !f.verdict && !f.landed)).toEqual([]);
    expect(seen.at(-1)).toEqual({ verdict: false, landed: true });
  });

  test("a branch behind main is rebased first, so the landing carries no merge of main", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    sh(wt.path, "git", "add", "-A");
    sh(wt.path, "git", "commit", "-qm", "add feature");
    sh(w.repo, "git", "commit", "--allow-empty", "-qm", "main moves on");
    w.state.requireRepo(repoId).config.land = { method: "rebase" };
    const { result } = await w.worktrees.land(wt.id);
    expect(result.ok).toBe(true);
    // a fast-forward: the feature commit sits on top of main's own, and nothing merged anything
    expect(await parents()).toBe(1);
    expect(await subjects()).toEqual(["add feature", "main moves on", "init"]);
  });

  test("squash lands the branch as one commit carrying the suggested message", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    for (const n of [1, 2]) {
      writeFileSync(join(wt.path, `f${n}.txt`), "x\n");
      sh(wt.path, "git", "add", "-A");
      sh(wt.path, "git", "commit", "-qm", `step ${n}`);
    }
    w.state.requireRepo(repoId).config.land = { method: "squash" };
    w.worktrees.setLanding(wt.id, {
      at: 1,
      check: "none",
      ready: true,
      subject: "add the feature",
      body: "Two steps.",
      fingerprint: "f",
    });
    const { result } = await w.worktrees.land(wt.id);
    expect(result.ok).toBe(true);
    expect(await parents()).toBe(1);
    expect(await subjects()).toEqual(["add the feature", "init"]);
    expect((await git(w.repo, "log", "-1", "--format=%b")).out).toBe("Two steps.");
    expect((await git(wt.path, "rev-parse", "HEAD")).out).toBe((await git(w.repo, "rev-parse", "main")).out);
  });

  test("a rebase that conflicts is aborted and the branch is left as it was", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    writeFileSync(join(wt.path, "README.md"), "theirs\n");
    sh(wt.path, "git", "commit", "-qam", "theirs");
    writeFileSync(join(w.repo, "README.md"), "ours\n");
    sh(w.repo, "git", "commit", "-qam", "ours");
    const { result } = await w.worktrees.land(wt.id);
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe("rebase");
    // resolving them is the agent's, so it is sent the turn and the composer is left alone
    expect(result.asked).toBe(true);
    expect(sent(wt.id)).toEqual([
      {
        text: fixPrompt({ kind: "conflict", base: "main", how: "rebase", step: ran() }),
        asked: { kind: "conflict", why: "the branch needs a rebase onto main", toolId: row },
      },
    ]);
    expect((await git(wt.path, "status", "--porcelain")).out).toBe("");
    expect(readFileSync(join(wt.path, "README.md"), "utf8")).toBe("theirs\n");
    expect((await git(wt.path, "log", "-1", "--format=%s")).out).toBe("theirs");
  });

  test("land commits with the message it is given and merges; the worktree stays, marked landed", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    w.worktrees.setLanding(wt.id, { at: 1, check: "pass", ready: true, subject: "old words", fingerprint: "f" });
    const { result, archiveIds } = await w.worktrees.land(wt.id, "add feature\n\nOne file.");
    expect(result.ok).toBe(true);
    expect(result.message).toBe("committed and merged into main");
    expect(archiveIds).toEqual([]);
    expect(existsSync(join(w.repo, "feature.txt"))).toBe(true);
    // main had not moved, so the merge fast-forwards onto the commit itself
    expect((await git(w.repo, "log", "-1", "--format=%s", "main^2")).out).toBe("add feature");
    expect(w.state.worktree(wt.id)).toMatchObject({ landed: true });
    expect(w.state.worktree(wt.id)?.landing).toBeUndefined();
    expect(existsSync(wt.path)).toBe(true);
  });

  test("land takes the suggested message when none is typed, and refuses with neither", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    await expect(w.worktrees.land(wt.id)).rejects.toBeInstanceOf(UserError);
    w.worktrees.setLanding(wt.id, { at: 1, check: "none", ready: true, subject: "add the feature", fingerprint: "f" });
    expect((await w.worktrees.land(wt.id)).result.ok).toBe(true);
    expect((await git(w.repo, "log", "-1", "--format=%s", "main^2")).out).toBe("add the feature");
  });

  test("a land mid-turn goes through on the tree the check saw, and is refused once the agent has written since", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    w.worktrees.setLanding(wt.id, {
      at: 1,
      check: "pass",
      ready: true,
      subject: "add the feature",
      fingerprint: await treeFingerprint(wt.path),
    });
    (w.runtime.agentFor(wt.id) as unknown as FakeAgent).status = "working";
    writeFileSync(join(wt.path, "half.txt"), "y\n");
    const refused = await w.worktrees.land(wt.id);
    expect(refused.result.ok).toBe(false);
    expect(refused.result.message).toContain("changed files since the check");
    // nothing was committed and the op is off the row
    expect((await git(wt.path, "status", "--porcelain")).out).toContain("feature.txt");
    expect(w.worktrees.shippingOf(wt.id)).toBeUndefined();
    rmSync(join(wt.path, "half.txt"));
    expect((await w.worktrees.land(wt.id)).result.ok).toBe(true);
    expect(existsSync(join(w.repo, "feature.txt"))).toBe(true);
    expect(existsSync(join(w.repo, "half.txt"))).toBe(false);
  });

  test("a branch switched by hand in the worktree is the row's branch: a status reads it and a land lands it", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    const born = wt.branch;
    sh(wt.path, "git", "switch", "-q", "-c", "mine");
    writeFileSync(join(wt.path, "mine.txt"), "x\n");
    sh(wt.path, "git", "add", "-A");
    sh(wt.path, "git", "commit", "-qm", "on mine");
    const tip = (await git(wt.path, "rev-parse", "HEAD")).out;
    await w.worktrees.gitStatus(wt.id);
    expect(w.state.worktree(wt.id)?.branch).toBe("mine");
    // a land takes the checkout's branch, not the one the row was born with, which is still on
    // main with nothing to land; the checkout is not reset under the switch
    const { result } = await w.worktrees.land(wt.id);
    expect(result.ok).toBe(true);
    expect((await git(w.repo, "log", "-1", "--format=%s", "main^2")).out).toBe("on mine");
    expect((await git(w.repo, "merge-base", "--is-ancestor", tip, "main")).ok).toBe(true);
    // a branch not toyon's keeps its history rather than restarting from main
    expect((await git(wt.path, "rev-parse", "HEAD")).out).toBe(tip);
    expect((await git(wt.path, "branch", "--show-current")).out).toBe("mine");
    expect(w.state.worktree(wt.id)).toMatchObject({ branch: "mine", landed: true });
    expect((await git(w.repo, "branch", "--list", born)).out).toContain(born);
    // detached: the record keeps its branch, and the land says so
    sh(wt.path, "git", "switch", "-q", "--detach");
    await w.worktrees.gitStatus(wt.id);
    expect(w.state.worktree(wt.id)?.branch).toBe("mine");
  });

  test("land syncs main in first when the branch is behind, and a file on main in the way refuses", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    sh(w.repo, "git", "commit", "--allow-empty", "-qm", "main moves on");
    // an edit on main the branch never touches rides along; the file the branch adds, started on
    // main too and never committed, is the one thing in the landing's way
    writeFileSync(join(w.repo, "README.md"), "edited on main\n");
    writeFileSync(join(w.repo, "feature.txt"), "started on main\n");
    const refused = await w.worktrees.land(wt.id, "add feature");
    expect(refused.result.ok).toBe(false);
    expect(refused.result.message).toContain("would overwrite (feature.txt)");
    // the commit stood: the work is safer committed, and the worktree is still there to try again
    expect(w.state.worktree(wt.id)).toBeDefined();
    expect((await git(wt.path, "status", "--porcelain")).out).toBe("");
    rmSync(join(w.repo, "feature.txt"));
    const { result } = await w.worktrees.land(wt.id);
    expect(result.ok).toBe(true);
    expect((await git(w.repo, "log", "--format=%s", "-n", "4")).out.split("\n")).toContain("main moves on");
    expect(readFileSync(join(w.repo, "README.md"), "utf8")).toBe("edited on main\n");
  });

  test("a status read marks a verdict stale once the tree no longer matches it, and clears the mark when it does again", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    w.worktrees.setLanding(wt.id, {
      at: 1,
      check: "none",
      ready: true,
      subject: "add the feature",
      fingerprint: await treeFingerprint(wt.path),
    });
    await w.worktrees.gitStatus(wt.id);
    expect(w.state.worktree(wt.id)?.landing?.ready).toBe(true);
    expect(w.state.worktree(wt.id)?.landing?.stale).toBeUndefined();
    writeFileSync(join(wt.path, "feature.txt"), "x\ny\n");
    await w.worktrees.gitStatus(wt.id);
    // the words stay for the box; the word waits on the check
    expect(w.state.worktree(wt.id)?.landing).toMatchObject({ ready: true, subject: "add the feature", stale: true });
    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    await w.worktrees.gitStatus(wt.id);
    expect(w.state.worktree(wt.id)?.landing?.stale).toBeUndefined();
  });

  test("land is refused from main, and with nothing to land", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    expect((await w.worktrees.land(wt.id)).result.ok).toBe(false);
    const main = w.state.worktrees.find((x) => x.kind === "main")!;
    await expect(w.worktrees.land(main.id)).rejects.toBeInstanceOf(UserError);
  });

  test("a conflicted sync says so and leaves the tree as it was", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    writeFileSync(join(wt.path, "README.md"), "theirs\n");
    sh(wt.path, "git", "commit", "-qam", "theirs");
    writeFileSync(join(w.repo, "README.md"), "ours\n");
    sh(w.repo, "git", "commit", "-qam", "ours");
    const { result } = await w.worktrees.sync(wt.id);
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe("rebase");
    expect(result.asked).toBe(true);
    expect(asked(wt.id)).toEqual([fixPrompt({ kind: "conflict", base: "main", how: "rebase", step: ran() })]);
    expect((await git(wt.path, "status", "--porcelain")).out).toBe("");
    expect(readFileSync(join(wt.path, "README.md"), "utf8")).toBe("theirs\n");
  });

  test("a branch that merged main to clear a conflict is merged with after, never rebased back into it", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    writeFileSync(join(wt.path, "README.md"), "theirs\n");
    sh(wt.path, "git", "commit", "-qam", "theirs");
    writeFileSync(join(w.repo, "README.md"), "ours\n");
    sh(w.repo, "git", "commit", "-qam", "ours");
    expect((await w.worktrees.sync(wt.id)).result.conflict).toBe("rebase");
    // the conflict resolved by a merge, the way an agent may do it whatever it was asked
    expect((await git(wt.path, "merge", "main")).ok).toBe(false);
    writeFileSync(join(wt.path, "README.md"), "both\n");
    sh(wt.path, "git", "commit", "-qam", "merge main");
    writeFileSync(join(w.repo, "newer.txt"), "x\n");
    sh(w.repo, "git", "add", "newer.txt");
    sh(w.repo, "git", "commit", "-qm", "main moves again");
    const { result } = await w.worktrees.sync(wt.id);
    expect(result).toMatchObject({ ok: true });
    expect(readFileSync(join(wt.path, "README.md"), "utf8")).toBe("both\n");
    expect(existsSync(join(wt.path, "newer.txt"))).toBe(true);
    expect((await w.worktrees.gitStatus(wt.id))?.behind).toBe(0);
  });

  test("a landing by rebase refuses a branch that holds a merge, and main stays where it was", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    sh(wt.path, "git", "add", "-A");
    sh(wt.path, "git", "commit", "-qm", "add feature");
    sh(w.repo, "git", "commit", "--allow-empty", "-qm", "main moves on");
    sh(wt.path, "git", "merge", "-q", "--no-edit", "main");
    const was = (await git(w.repo, "rev-parse", "main")).out;
    w.state.requireRepo(repoId).config.land = { method: "rebase" };
    const { result } = await w.worktrees.land(wt.id);
    expect(result).toMatchObject({ ok: false, conflict: "rebase" });
    expect(result.message).toContain("merge commit");
    expect((await git(w.repo, "rev-parse", "main")).out).toBe(was);
    // one commit is still a way to land it
    w.state.requireRepo(repoId).config.land = { method: "squash" };
    expect((await w.worktrees.land(wt.id)).result.ok).toBe(true);
  });

  describe("a sync over uncommitted work", () => {
    /** a worktree one commit ahead, with an edit, a staged new file and an untracked one */
    const dirtyWorktree = async () => {
      const repoId = await registered();
      const wt = await w.worktrees.create(repoId, "feature");
      writeFileSync(join(wt.path, "mine.txt"), "committed\n");
      sh(wt.path, "git", "add", "mine.txt");
      sh(wt.path, "git", "commit", "-qm", "mine");
      writeFileSync(join(wt.path, "mine.txt"), "edited\n");
      writeFileSync(join(wt.path, "staged.txt"), "staged\n");
      sh(wt.path, "git", "add", "staged.txt");
      writeFileSync(join(wt.path, "loose.txt"), "loose\n");
      return wt;
    };
    const mainMoves = (file: string, text: string) => {
      writeFileSync(join(w.repo, file), text);
      sh(w.repo, "git", "add", file);
      sh(w.repo, "git", "commit", "-qm", `main: ${file}`);
    };
    const porcelain = async (path: string) => (await git(path, "status", "--porcelain")).out;
    const head = async (path: string) => (await git(path, "rev-parse", "HEAD")).out;
    /** nothing of the carry is left behind: not its ref, and nothing on the shared stash stack */
    const noTrace = async (path: string) => {
      expect((await git(path, "rev-parse", "-q", "--verify", CARRIED)).ok).toBe(false);
      expect((await git(path, "stash", "list")).out).toBe("");
    };

    test("the work rides across: main comes in under it and every file reads as it did", async () => {
      const wt = await dirtyWorktree();
      mainMoves("newer.txt", "x\n");
      const { result } = await w.worktrees.sync(wt.id);
      expect(result).toMatchObject({ ok: true });
      expect(existsSync(join(wt.path, "newer.txt"))).toBe(true);
      expect((await w.worktrees.gitStatus(wt.id))?.behind).toBe(0);
      expect(readFileSync(join(wt.path, "mine.txt"), "utf8")).toBe("edited\n");
      expect(readFileSync(join(wt.path, "staged.txt"), "utf8")).toBe("staged\n");
      expect(readFileSync(join(wt.path, "loose.txt"), "utf8")).toBe("loose\n");
      await noTrace(wt.path);
    });

    test("work that no longer fits over main refuses, named, and the branch is back where it was", async () => {
      const wt = await dirtyWorktree();
      writeFileSync(join(wt.path, "README.md"), "mine, uncommitted\n");
      const [before, was] = [await porcelain(wt.path), await head(wt.path)];
      mainMoves("README.md", "main's\n");
      const { result } = await w.worktrees.sync(wt.id);
      expect(result.ok).toBe(false);
      expect(result.conflict).toBeUndefined();
      expect(result.message).toContain("(README.md)");
      expect(await head(wt.path)).toBe(was);
      expect(await porcelain(wt.path)).toBe(before);
      expect(readFileSync(join(wt.path, "README.md"), "utf8")).toBe("mine, uncommitted\n");
      await noTrace(wt.path);
    });

    test("a rebase that conflicts is aborted with the work put back as it was", async () => {
      const wt = await dirtyWorktree();
      const [before, was] = [await porcelain(wt.path), await head(wt.path)];
      mainMoves("mine.txt", "main's\n");
      const { result } = await w.worktrees.sync(wt.id);
      expect(result).toMatchObject({ ok: false, conflict: "rebase" });
      expect(await head(wt.path)).toBe(was);
      expect(await porcelain(wt.path)).toBe(before);
      expect(readFileSync(join(wt.path, "mine.txt"), "utf8")).toBe("edited\n");
      await noTrace(wt.path);
    });

    test("a merge staged and not committed refuses it, and the merge is still in progress after", async () => {
      const wt = await dirtyWorktree();
      mainMoves("newer.txt", "x\n");
      sh(wt.path, "git", "commit", "-qam", "mine again");
      sh(wt.path, "git", "merge", "-q", "--no-commit", "--no-ff", "main");
      const [before, was] = [await porcelain(wt.path), await head(wt.path)];
      const { result } = await w.worktrees.sync(wt.id);
      expect(result.ok).toBe(false);
      expect(result.conflict).toBeUndefined();
      expect(result.message).toContain("merge is unfinished");
      expect((await git(wt.path, "rev-parse", "-q", "--verify", "MERGE_HEAD")).ok).toBe(true);
      expect(await head(wt.path)).toBe(was);
      expect(await porcelain(wt.path)).toBe(before);
      await noTrace(wt.path);
    });

    test("an untracked file main now has refuses by name, nothing moved", async () => {
      const wt = await dirtyWorktree();
      const before = await porcelain(wt.path);
      mainMoves("loose.txt", "main's\n");
      const { result } = await w.worktrees.sync(wt.id);
      expect(result.ok).toBe(false);
      expect(result.conflict).toBeUndefined();
      expect(result.message).toContain("loose.txt");
      expect(await porcelain(wt.path)).toBe(before);
      expect(readFileSync(join(wt.path, "loose.txt"), "utf8")).toBe("loose\n");
      await noTrace(wt.path);
    });

    test("a turn in flight refuses it; the same tree syncs once the agent is idle", async () => {
      const wt = await dirtyWorktree();
      mainMoves("newer.txt", "x\n");
      const agent = w.runtime.agentFor(wt.id) as unknown as FakeAgent;
      agent.status = "working";
      await expect(w.worktrees.sync(wt.id)).rejects.toBeInstanceOf(UserError);
      expect(existsSync(join(wt.path, "newer.txt"))).toBe(false);
      agent.status = "idle";
      expect((await w.worktrees.sync(wt.id)).result.ok).toBe(true);
    });
  });

  test("commit with an empty message is a UserError", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    await expect(w.worktrees.commit(wt.id, "  ")).rejects.toBeInstanceOf(UserError);
  });

  // the rail's badges stand for 10s between reads; a landing op that moves the worktree's own HEAD
  // has to read them again before its frame, or the rail keeps showing the count the person just
  // acted on
  test("sync and commit refresh the badge counts at once and push a worktrees frame", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    // create's setup and procs run behind it, and runtime.start emits once the proxy is up; a frame
    // from that landing inside a sync or commit below would be counted as theirs
    await until(() => w.runtime.get(wt.id)?.proxy != null);
    // the frames an op pushes while it runs list it (its start, each step); the one that carries
    // the fresh counts is the one with the op gone, and there is one of those
    let frames = 0;
    w.hub.on("worktreesChanged", () => {
      if (!w.worktrees.shippingOf(wt.id)) frames++;
    });
    const row = async () => (await counted()).find((s) => s.id === wt.id)!;

    sh(w.repo, "git", "commit", "--allow-empty", "-m", "main moves on");
    w.worktrees.invalidateCounts();
    expect((await row()).behind).toBe(1);

    frames = 0;
    expect((await w.worktrees.sync(wt.id)).result.ok).toBe(true);
    expect(frames).toBe(1);
    expect((await row()).behind).toBe(0);
    expect((await row()).ahead).toBe(0);

    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    frames = 0;
    expect((await w.worktrees.commit(wt.id, "add feature")).ok).toBe(true);
    expect(frames).toBe(1);
    expect((await row()).ahead).toBe(1);
  });
});
