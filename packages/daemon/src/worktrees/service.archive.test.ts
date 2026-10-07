import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sh } from "../../test/helpers/tmp-repo.ts";
import { registered, settle, until, useWorld, w } from "../../test/helpers/world.ts";
import { PLANS_DIR, writePlanDoc } from "../agent/planDoc.ts";
import { transcriptPathFor } from "../agent/transcript.ts";
import { UserError } from "../core/errors.ts";
import { archiveRef, keepState } from "../git/archive.ts";
import { git } from "../git/exec.ts";

// What git keeps of a worktree once it is gone: the archive ref, its changes and history, and a graft back onto a new one.

useWorld();

describe("archive", () => {
  const userLine = (text: string) => `${JSON.stringify({ seq: 0, event: { type: "user-message", text, ts: 1 } })}\n`;
  const ref = (id: string) => `refs/toyon/archive/${id}`;
  const refExists = async (id: string) => (await git(w.repo, "rev-parse", "--verify", "--quiet", ref(id))).ok;

  /** a worktree with a commit of its own, an edit, an untracked file, a chat and a session */
  async function workedOn(repoId: string) {
    const wt = await w.worktrees.create(repoId, "tidy the footer");
    await settle();
    writeFileSync(join(wt.path, "done.txt"), "committed\n");
    sh(wt.path, "git", "add", "done.txt");
    sh(wt.path, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "done");
    writeFileSync(join(wt.path, "README.md"), "edited\n");
    writeFileSync(join(wt.path, "wip.txt"), "untracked\n");
    writeFileSync(transcriptPathFor(w.paths.transcriptsDir, wt.id), userLine("tidy the footer"));
    w.state.setSession(wt.id, "session-1");
    return { wt, head: sh(wt.path, "git", "rev-parse", "HEAD") };
  }

  test("remove keeps the commits and uncommitted work under a ref beside the archived chat", async () => {
    const repoId = await registered();
    const { wt, head } = await workedOn(repoId);
    // the spend rides along: what the stream last said, so the archived row can still show it
    w.hub.emit("agent", wt.id, 1, { type: "usage", used: 1000, size: 4000, cost: 1.4, ts: 0 });
    const archived = await w.worktrees.archiveWorktree(wt.id);
    expect(archived).toMatchObject({
      id: wt.id,
      title: wt.title,
      branch: wt.branch,
      prompt: "tidy the footer",
      restorable: true,
      uncommitted: true,
      cost: 1.4,
      // the chat and the session stay handable to another tool from the archived row
      transcript: join(w.paths.archiveDir, wt.id, "transcript.jsonl"),
      sessionId: "session-1",
    });
    expect(existsSync(archived?.transcript ?? "")).toBe(true);
    expect(existsSync(wt.path)).toBe(false);
    expect(sh(w.repo, "git", "branch", "--list", wt.branch)).toBe("");
    // the ref is the uncommitted work as a commit over the one the branch was on
    expect(sh(w.repo, "git", "rev-parse", `${ref(wt.id)}^`)).toBe(head);
    expect(sh(w.repo, "git", "show", `${ref(wt.id)}:wip.txt`)).toBe("untracked");
    expect(w.worktrees.archived(repoId).map((a) => a.id)).toEqual([wt.id]);
  });

  test("restore puts back the branch, the commits, the uncommitted work, the chat and the session", async () => {
    const repoId = await registered();
    const { wt, head } = await workedOn(repoId);
    await w.worktrees.archiveWorktree(wt.id);
    const back = await w.worktrees.restore(wt.id, "tab-1");
    await settle();
    expect(back).toMatchObject({ id: wt.id, path: wt.path, branch: wt.branch, createdBy: "tab-1" });
    // back to work in it: the rail puts it with what was last sent to
    expect(back.promptedAt).toBeGreaterThan(wt.promptedAt ?? 0);
    expect(sh(back.path, "git", "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(back.path, "README.md"), "utf8")).toBe("edited\n");
    expect(readFileSync(join(back.path, "wip.txt"), "utf8")).toBe("untracked\n");
    expect(readFileSync(transcriptPathFor(w.paths.transcriptsDir, wt.id), "utf8")).toBe(userLine("tidy the footer"));
    expect(w.state.session(wt.id)).toBe("session-1");
    expect(w.state.worktree(wt.id)).toBeDefined();
    expect(await refExists(wt.id)).toBe(false);
    expect(w.worktrees.archived(repoId)).toEqual([]);
    // the word on it goes on the transcript, where the chat reads why it stops and picks up again
    expect(w.agents.get(wt.id)!.recorded.at(-1)).toMatchObject({
      type: "restored",
      branch: wt.branch,
      uncommitted: true,
    });
  });

  test("a restored worktree comes back parked: nothing that wakes one starts its procs", async () => {
    const repoId = await registered();
    const { wt } = await workedOn(repoId);
    await until(() => !!w.runtime.get(wt.id)?.procs);
    await w.worktrees.archiveWorktree(wt.id);
    const back = await w.worktrees.restore(wt.id, undefined, { text: "what did we decide" });
    await settle();
    expect(back.parked).toBe(true);
    expect(w.runtime.get(wt.id)?.procs).toBeNull();
    // a tab landing on it, a restarted daemon, a finished turn: all of them come through wake
    await w.runtime.wake(wt.id);
    expect(w.runtime.get(wt.id)?.procs).toBeNull();
    expect(w.runtime.previewStanding(wt.id)).toEqual({ status: "parked" });
    // a shell command is still a question
    w.hub.emit("agent", wt.id, 1, { type: "tool-start", toolId: "t1", name: "Bash", input: {}, kind: "execute" });
    await settle();
    expect(w.state.worktree(wt.id)?.parked).toBe(true);
  });

  test("a parked worktree's procs start when someone asks, or when its agent writes a file", async () => {
    const repoId = await registered();
    const { wt } = await workedOn(repoId);
    await w.worktrees.archiveWorktree(wt.id);
    await w.worktrees.restore(wt.id);
    await settle();
    w.worktrees.startPreview(wt.id);
    await until(() => !!w.runtime.get(wt.id)?.procs);
    expect(w.state.worktree(wt.id)?.parked).toBeUndefined();

    await w.worktrees.archiveWorktree(wt.id);
    await w.worktrees.restore(wt.id);
    await settle();
    expect(w.runtime.get(wt.id)?.procs).toBeNull();
    w.hub.emit("agent", wt.id, 1, { type: "tool-start", toolId: "t2", name: "Edit", input: {}, kind: "edit" });
    await until(() => !!w.runtime.get(wt.id)?.procs);
    expect(w.state.worktree(wt.id)?.parked).toBeUndefined();
  });

  test("the archived chat is readable in place, and a message on restore goes to the agent", async () => {
    const repoId = await registered();
    const { wt } = await workedOn(repoId);
    await w.worktrees.archiveWorktree(wt.id);
    expect(w.worktrees.archived(repoId)[0]).toMatchObject({ path: wt.path });
    expect(w.worktrees.archivedTranscript(wt.id)).toEqual([
      { seq: 0, event: { type: "user-message", text: "tidy the footer", ts: 1 } },
    ]);
    expect(w.worktrees.archivedTranscript("nope")).toBeNull();
    expect(w.worktrees.archivedAttachment(wt.id, "1.png")).toBe(
      join(w.paths.archiveDir, wt.id, "attachments", "1.png"),
    );
    expect(w.worktrees.archivedAttachment(wt.id, "../record.json")).toBeNull();
    await w.worktrees.restore(wt.id, undefined, { text: "and the header" });
    await settle();
    expect(w.agents.get(wt.id)?.sent.at(-1)).toMatchObject({ text: "and the header" });
    expect(w.worktrees.archivedTranscript(wt.id)).toBeNull();
  });

  test("a restore asked for twice brings back one row, and a message sent meanwhile reaches it", async () => {
    const repoId = await registered();
    const { wt } = await workedOn(repoId);
    await w.worktrees.archiveWorktree(wt.id);
    // the page stays up until the row is listed: two presses of restore, and a message typed in
    // between, all before the first has checked anything out
    const [first, second, typed] = await Promise.all([
      w.worktrees.restore(wt.id, "tab-1"),
      w.worktrees.restore(wt.id, "tab-1"),
      w.worktrees.restore(wt.id, "tab-1", { text: "and the header" }),
    ]);
    await settle();
    expect(second).toBe(first);
    expect(typed).toBe(first);
    expect(w.state.worktrees.filter((x) => x.id === wt.id)).toHaveLength(1);
    expect(existsSync(first.path)).toBe(true);
    expect(w.agents.get(wt.id)?.sent.map((m) => m.text)).toEqual(["and the header"]);
    // a press that lands after the row is back is answered with the row, and its message goes to
    // the row's agent rather than being refused as an archive that is gone
    const again = await w.worktrees.restore(wt.id, "tab-1", { text: "once more" });
    await settle();
    expect(again).toBe(first);
    expect(w.state.worktrees.filter((x) => x.id === wt.id)).toHaveLength(1);
    expect(w.agents.get(wt.id)?.sent.map((m) => m.text)).toEqual(["and the header", "once more"]);
  });

  test("the plans a worktree was shown go with its chat, read on its page, and come back on restore", async () => {
    const repoId = await registered();
    const { wt } = await workedOn(repoId);
    const one = await writePlanDoc(wt.path, "# plan one");
    const two = await writePlanDoc(wt.path, "# plan two");
    expect([one, two]).toEqual([`${PLANS_DIR}/1.md`, `${PLANS_DIR}/2.md`]);
    await w.worktrees.archiveWorktree(wt.id);
    expect(readFileSync(join(w.paths.archiveDir, wt.id, "plans", "2.md"), "utf8")).toBe("# plan two\n");
    expect(existsSync(join(w.paths.archiveDir, `${wt.id}.plans`))).toBe(false);
    // kept out of git, so the snapshot has none of it: the copy beside the chat is the only one
    expect((await git(w.repo, "show", `${ref(wt.id)}:${PLANS_DIR}/1.md`)).ok).toBe(false);
    expect(await w.worktrees.archivedFile(wt.id, `${PLANS_DIR}/1.md`)).toEqual({
      before: "# plan one\n",
      after: "# plan one\n",
    });
    // a path shaped like a plan but not one never reaches the archive folder; it falls through to
    // git, which has nothing there either
    const stray = await w.worktrees.archivedFile(wt.id, `${PLANS_DIR}/../record.json`);
    expect(stray?.after ?? "").not.toContain("archivedAt");
    expect(await w.worktrees.archivedFile(wt.id, `${PLANS_DIR}/3.md`)).toEqual({ before: "", after: "" });
    const back = await w.worktrees.restore(wt.id);
    await settle();
    expect(readFileSync(join(back.path, PLANS_DIR, "1.md"), "utf8")).toBe("# plan one\n");
    expect(existsSync(join(w.paths.archiveDir, wt.id))).toBe(false);
    expect(sh(back.path, "git", "status", "--porcelain", "--", ".toyon")).toBe("");
  });

  test("a worktree shown no plan archives and restores with no plans folder", async () => {
    const repoId = await registered();
    const { wt } = await workedOn(repoId);
    await w.worktrees.archiveWorktree(wt.id);
    expect(existsSync(join(w.paths.archiveDir, wt.id, "plans"))).toBe(false);
    const back = await w.worktrees.restore(wt.id);
    expect(existsSync(join(back.path, PLANS_DIR))).toBe(false);
  });

  test("a restore whose branch name was taken since comes back on a new branch", async () => {
    const repoId = await registered();
    const { wt, head } = await workedOn(repoId);
    await w.worktrees.archiveWorktree(wt.id);
    sh(w.repo, "git", "branch", wt.branch, "main");
    const back = await w.worktrees.restore(wt.id);
    expect(back.branch).not.toBe(wt.branch);
    expect(sh(back.path, "git", "rev-parse", "HEAD")).toBe(head);
    expect(sh(w.repo, "git", "rev-parse", wt.branch)).toBe(sh(w.repo, "git", "rev-parse", "main"));
  });

  test("delete forgets an archived worktree for good", async () => {
    const repoId = await registered();
    const { wt } = await workedOn(repoId);
    await w.worktrees.archiveWorktree(wt.id);
    await w.worktrees.deleteArchived(wt.id);
    expect(existsSync(join(w.paths.archiveDir, wt.id))).toBe(false);
    expect(await refExists(wt.id)).toBe(false);
    expect(w.worktrees.archived(repoId)).toEqual([]);
    await expect(w.worktrees.restore(wt.id)).rejects.toBeInstanceOf(UserError);
  });

  test("a worktree whose directory went while the daemon was down is archived, restorable from its branch", async () => {
    const repoId = await registered();
    const { wt, head } = await workedOn(repoId);
    await w.runtime.stop(wt.id);
    rmSync(wt.path, { recursive: true, force: true });
    await w.worktrees.forgetGone(wt);
    expect(w.state.worktree(wt.id)).toBeUndefined();
    expect(w.worktrees.archived(repoId)).toMatchObject([{ id: wt.id, restorable: true }]);
    const back = await w.worktrees.restore(wt.id);
    expect(sh(back.path, "git", "rev-parse", "HEAD")).toBe(head);
  });

  test("a remove git cannot finish still archives the work and takes the directory", async () => {
    const repoId = await registered();
    const { wt, head } = await workedOn(repoId);
    // a folder with no write bit: git deletes the worktree's record, fails on this file, and
    // leaves the directory behind
    mkdirSync(join(wt.path, "held"));
    writeFileSync(join(wt.path, "held", "f"), "x\n");
    chmodSync(join(wt.path, "held"), 0o555);
    const archived = await w.worktrees.archiveWorktree(wt.id);
    expect(archived?.id).toBe(wt.id);
    expect(existsSync(wt.path)).toBe(false);
    expect(w.state.worktree(wt.id)).toBeUndefined();
    expect(sh(w.repo, "git", "branch", "--list", wt.branch)).toBe("");
    const back = await w.worktrees.restore(wt.id);
    expect(sh(back.path, "git", "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(back.path, "wip.txt"), "utf8")).toBe("untracked\n");
  });

  test("a worktree whose record git dropped mid-remove archives on the next try with what the first kept", async () => {
    const repoId = await registered();
    const { wt, head } = await workedOn(repoId);
    // the first try as git leaves it: the ref written, the worktree's record gone, the directory
    // still there with a link to nowhere
    const gitDir = sh(wt.path, "git", "rev-parse", "--absolute-git-dir");
    const index = join(w.paths.archiveDir, `${wt.id}.index`);
    expect(await keepState(w.repo, wt.path, archiveRef(wt.id), index)).toMatchObject({ head, dirty: 2 });
    rmSync(gitDir, { recursive: true, force: true });
    expect((await git(wt.path, "rev-parse", "HEAD")).ok).toBe(false);
    const archived = await w.worktrees.archiveWorktree(wt.id);
    expect(archived?.id).toBe(wt.id);
    expect(existsSync(wt.path)).toBe(false);
    expect(w.state.worktree(wt.id)).toBeUndefined();
    expect(w.worktrees.archived(repoId)).toMatchObject([{ id: wt.id, restorable: true, dirty: 2 }]);
    const back = await w.worktrees.restore(wt.id);
    expect(sh(back.path, "git", "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(back.path, "README.md"), "utf8")).toBe("edited\n");
    expect(readFileSync(join(back.path, "wip.txt"), "utf8")).toBe("untracked\n");
  });

  test("a spare's removal archives nothing", async () => {
    const repoId = await registered();
    await w.worktrees.spare.ensure(repoId);
    const spare = w.state.worktrees.find((x) => x.kind === "spare")!;
    writeFileSync(transcriptPathFor(w.paths.transcriptsDir, spare.id), userLine("warming"));
    await w.worktrees.discardWorktree(spare.id);
    expect(w.state.worktree(spare.id)).toBeUndefined();
    expect(existsSync(transcriptPathFor(w.paths.transcriptsDir, spare.id))).toBe(false);
    expect(w.worktrees.archived(repoId)).toEqual([]);
  });

  test("forgetting a project deletes the chat on main, which has nowhere to come back to", async () => {
    const repoId = await registered();
    const main = w.state.worktrees.find((x) => x.repoId === repoId && x.kind === "main")!;
    writeFileSync(transcriptPathFor(w.paths.transcriptsDir, main.id), userLine("on main"));
    await w.repos.forget(repoId);
    expect(existsSync(transcriptPathFor(w.paths.transcriptsDir, main.id))).toBe(false);
  });
});

// An archived worktree's page shows the changes panel from what git kept: every commit the worktree
// made, grouped by the landing that carried it, whatever the merge method did to them on main.
describe("an archived worktree's changes and history", () => {
  const commitFile = (dir: string, name: string) => {
    writeFileSync(join(dir, name), `${name}\n`);
    sh(dir, "git", "add", "-A");
    sh(dir, "git", "commit", "-qm", `add ${name}`);
  };
  const subjects = (list: Array<{ subject: string }>) => list.map((c) => c.subject);
  const landRefs = async (id: string) =>
    (await git(w.repo, "for-each-ref", "--format=%(refname)", `refs/toyon/lands/${id}/`)).out;

  for (const method of ["merge", "rebase", "squash"] as const) {
    test(`a ${method} landing of four commits lists all four once the branch is gone`, async () => {
      const repoId = await registered();
      w.state.requireRepo(repoId).config.land = { method };
      const wt = await w.worktrees.create(repoId, "feature");
      for (const n of [1, 2, 3, 4]) commitFile(wt.path, `f${n}.txt`);
      const tip = sh(wt.path, "git", "rev-parse", "HEAD");
      // a squash commits under the verdict's message, as a real landing has one
      w.worktrees.setLanding(wt.id, {
        at: 1,
        check: "none",
        ready: true,
        subject: "add the feature",
        body: "Four steps.",
        fingerprint: "f",
      });
      expect((await w.worktrees.land(wt.id)).result).toMatchObject({ ok: true });
      const lands = w.state.worktree(wt.id)?.lands ?? [];
      expect(lands).toMatchObject([{ tip }]);
      // the branch restarted from main, so the ref is what keeps the four alive
      expect(sh(w.repo, "git", "rev-parse", `refs/toyon/lands/${wt.id}/0`)).toBe(tip);
      await w.worktrees.archiveWorktree(wt.id);
      const log = await w.worktrees.gitLog(wt.id);
      expect(subjects(log)).toEqual(["add f4.txt", "add f3.txt", "add f2.txt", "add f1.txt"]);
      expect(log.map((c) => c.landedAt)).toEqual(Array(4).fill(lands[0]?.at));
      expect(await w.worktrees.gitStatus(wt.id)).toMatchObject({ files: [], committed: [] });
      expect(await w.worktrees.commitFiles(wt.id, log[0]!.sha)).toMatchObject([{ path: "f4.txt" }]);
    });
  }

  test("each landing is its own run, and work after the last one is listed apart with its changes", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    commitFile(wt.path, "a.txt");
    expect((await w.worktrees.land(wt.id)).result.ok).toBe(true);
    commitFile(wt.path, "b.txt");
    commitFile(wt.path, "c.txt");
    expect((await w.worktrees.land(wt.id)).result.ok).toBe(true);
    commitFile(wt.path, "d.txt");
    writeFileSync(join(wt.path, "wip.txt"), "wip\n");
    const [first, second] = w.state.worktree(wt.id)?.lands ?? [];
    await w.worktrees.archiveWorktree(wt.id);
    const log = await w.worktrees.gitLog(wt.id);
    expect(subjects(log)).toEqual(["add d.txt", "add c.txt", "add b.txt", "add a.txt"]);
    expect(log.map((c) => c.landedAt)).toEqual([undefined, second?.at, second?.at, first?.at]);
    expect(await w.worktrees.gitStatus(wt.id)).toMatchObject({
      files: [{ path: "wip.txt" }],
      committed: [{ path: "d.txt" }],
    });
    // the changes list's diff: what never landed against where it forked, uncommitted work included
    expect(await w.worktrees.archivedFile(wt.id, "wip.txt")).toEqual({ before: "", after: "wip\n" });
    expect(await w.worktrees.archivedFile(wt.id, "c.txt", log[1]!.sha)).toEqual({ before: "", after: "c.txt\n" });
    expect(await w.worktrees.archivedFile("nope", "c.txt")).toBeNull();
  });

  test("a worktree that never landed lists its own commits and nothing of main's", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    commitFile(wt.path, "a.txt");
    sh(w.repo, "git", "commit", "--allow-empty", "-qm", "main moves on");
    await w.worktrees.archiveWorktree(wt.id);
    expect(subjects(await w.worktrees.gitLog(wt.id))).toEqual(["add a.txt"]);
    expect(await w.worktrees.gitStatus(wt.id)).toMatchObject({ files: [], committed: [{ path: "a.txt" }] });
  });

  test("deleting it for good lets go of what it landed", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    commitFile(wt.path, "a.txt");
    expect((await w.worktrees.land(wt.id)).result.ok).toBe(true);
    await w.worktrees.archiveWorktree(wt.id);
    expect(await landRefs(wt.id)).not.toBe("");
    await w.worktrees.deleteArchived(wt.id);
    expect(await landRefs(wt.id)).toBe("");
    expect(await w.worktrees.gitLog(wt.id)).toEqual([]);
  });
});

describe("graft", () => {
  const commitIn = (path: string, file: string) => {
    writeFileSync(join(path, file), `${file}\n`);
    sh(path, "git", "add", "-A");
    sh(path, "git", "commit", "-qm", file);
  };

  test("merges the source into the target, appends its transcript, and removes it", async () => {
    const repoId = await registered();
    const a = await w.worktrees.create(repoId, "alpha");
    const b = await w.worktrees.create(repoId, "beta");
    await settle();
    commitIn(a.path, "a.txt");
    commitIn(b.path, "b.txt");
    w.agents.get(b.id)!.note({ type: "user-message", text: "in beta", ts: 1 });
    const portBefore = a.proxyPort;
    const { target, grafted } = await w.worktrees.graft(a.id, [b.id]);
    expect(target.id).toBe(a.id);
    expect(grafted).toEqual([b.title]);
    expect(existsSync(join(a.path, "b.txt"))).toBe(true);
    expect(w.state.worktree(b.id)).toBeUndefined();
    expect(existsSync(b.path)).toBe(false);
    expect((await git(w.repo, "branch", "--list", b.branch)).out).toBe("");
    // the target is the same worktree it was: same record, same port, procs never restarted
    expect(w.state.worktree(a.id)?.proxyPort).toBe(portBefore);
    expect(w.state.worktree(a.id)?.kind).toBe("worktree");
    // beta's history is now alpha's, behind a marker saying where it came from
    const recorded = w.agents.get(a.id)!.recorded;
    expect(recorded.map((e) => e.type)).toEqual(["grafted", "user-message"]);
    expect(recorded[0]).toMatchObject({ type: "grafted", title: b.title, branch: b.branch });
    // its history lives on in the target, so there is nothing to archive
    expect(w.worktrees.archived(repoId)).toEqual([]);
  });

  test("a dirty source is refused and nothing is touched", async () => {
    const repoId = await registered();
    const a = await w.worktrees.create(repoId, "alpha");
    const b = await w.worktrees.create(repoId, "beta");
    await settle();
    commitIn(b.path, "b.txt");
    writeFileSync(join(b.path, "wip.txt"), "not committed\n");
    const head = (await git(a.path, "rev-parse", "HEAD")).out;
    await expect(w.worktrees.graft(a.id, [b.id])).rejects.toThrow(`commit or discard the changes in ${b.title}`);
    expect(w.state.worktree(b.id)).toBeDefined();
    expect((await git(a.path, "rev-parse", "HEAD")).out).toBe(head);
    expect(existsSync(join(b.path, "wip.txt"))).toBe(true);
  });

  test("a conflict aborts the merge and removes nothing", async () => {
    const repoId = await registered();
    const a = await w.worktrees.create(repoId, "alpha");
    const b = await w.worktrees.create(repoId, "beta");
    await settle();
    writeFileSync(join(a.path, "README.md"), "from a\n");
    sh(a.path, "git", "commit", "-qam", "a");
    writeFileSync(join(b.path, "README.md"), "from b\n");
    sh(b.path, "git", "commit", "-qam", "b");
    await expect(w.worktrees.graft(a.id, [b.id])).rejects.toBeInstanceOf(UserError);
    expect(w.state.worktree(b.id)).toBeDefined();
    expect(existsSync(join(a.path, ".git", "MERGE_HEAD")) || existsSync(join(a.path, "MERGE_HEAD"))).toBe(false);
    expect((await git(a.path, "status", "--porcelain")).out).toBe("");
    expect(readFileSync(join(a.path, "README.md"), "utf8")).toBe("from a\n");
  });

  test("a mid-turn agent, main, and a target among its own sources are refused", async () => {
    const repoId = await registered();
    const main = w.state.worktrees.find((x) => x.repoId === repoId && x.kind === "main")!;
    const a = await w.worktrees.create(repoId, "alpha");
    const b = await w.worktrees.create(repoId, "beta");
    await settle();
    commitIn(b.path, "b.txt");
    w.agents.get(b.id)!.status = "working";
    await expect(w.worktrees.graft(a.id, [b.id])).rejects.toThrow(/mid-turn/);
    w.agents.get(b.id)!.status = "idle";
    await expect(w.worktrees.graft(main.id, [b.id])).rejects.toBeInstanceOf(UserError);
    await expect(w.worktrees.graft(a.id, [main.id])).rejects.toBeInstanceOf(UserError);
    await expect(w.worktrees.graft(a.id, [a.id])).rejects.toBeInstanceOf(UserError);
    expect(w.state.worktree(b.id)).toBeDefined();
  });
});
