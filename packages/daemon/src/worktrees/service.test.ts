import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { SHELL_TOOL } from "@toyon/shared";
import { type FakeAgent, fakeAgents, fakeFactories } from "../../test/helpers/fakes.ts";
import { sh, tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { transcriptPathFor } from "../agent/transcript.ts";
import { UserError } from "../core/errors.ts";
import { Hub } from "../core/hub.ts";
import { SelfWatch } from "../core/self.ts";
import { StateStore } from "../core/state.ts";
import { ExecService } from "../exec/service.ts";
import { GIT, git } from "../git/exec.ts";
import { AfterLand } from "../repos/afterLand.ts";
import { RepoRegistry } from "../repos/registry.ts";
import { RuntimeRegistry } from "../runtime/registry.ts";
import { WorktreeService } from "./service.ts";
import { TurnService } from "./turns.ts";

// Real git in a throwaway repo; fake agent/procs/proxy so nothing is spawned and no SDK is called.

/** No daemon of toyon's own runs here, so nothing that lands in these repos can get ahead of one:
 * a registry needs the two anyway, and these are the pair that never has anything to say. */
function noSelf(state: StateStore, hub: Hub) {
  const self = new SelfWatch(null);
  return { self, afterLand: new AfterLand({ state, hub, self }) };
}

type World = ReturnType<typeof world>;
function world() {
  const t = tmpRepo();
  const state = new StateStore(t.paths);
  const hub = new Hub();
  const f = fakeFactories();
  const agents = fakeAgents(t.paths.agentsDir);
  const runtime = new RuntimeRegistry({ hub, state, paths: t.paths, agents, bridgeScript: () => "", ...f.factories });
  const exec = new ExecService({ state, runtime });
  const worktrees = new WorktreeService({
    state,
    hub,
    runtime,
    paths: t.paths,
    agents,
    namer: async () => null,
    record: (id, command, text, exit) => exec.record(id, command, text, exit),
  });
  const turns = new TurnService({ state, hub, transcript: (id) => runtime.agentFor(id)?.transcript() ?? [] });
  const repos = new RepoRegistry({ state, hub, runtime, worktrees, ...noSelf(state, hub) });
  return { ...t, state, hub, runtime, worktrees, turns, repos, registry: agents, ...f };
}

let w: World;
beforeEach(() => {
  w = world();
});
afterEach(async () => {
  await w.runtime.shutdown();
  w.repos.stopWatchers();
  w.cleanup();
});

// a repo with no package.json detects as needsSetup; flip it so procs/spares behave as confirmed
async function registered(): Promise<string> {
  const repo = await w.repos.register(w.repo);
  repo.needsSetup = false;
  repo.config = { run: { web: "true" } };
  w.state.save();
  return repo.id;
}

const settle = () => new Promise((r) => setTimeout(r, 50));

/** wait for background work to reach a state, where a fixed settle loses the race under load */
async function until(done: () => boolean, ms = 15_000): Promise<void> {
  const stop = Date.now() + ms;
  while (!done()) {
    if (Date.now() > stop) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}

describe("register", () => {
  test("creates the main pseudo-worktree with an agent and running procs", async () => {
    const repoId = await registered();
    const main = w.state.worktrees.find((x) => x.kind === "main")!;
    expect(main.repoId).toBe(repoId);
    expect(w.agents.get(main.id)).toBeDefined();
    // needsSetup was true at register time: no procs until the config card is confirmed
    expect(w.procs.get(main.id)?.started).toEqual([]);
  });
});

describe("create / remove", () => {
  test("create adds a git worktree on an toyon/ branch and the agent receives the prompt", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "make the header sticky");
    expect(wt.kind).toBe("worktree");
    expect(wt.branch).toMatch(/^toyon\/make-the-header-[0-9a-f]{4}$/);
    expect(existsSync(join(wt.path, "README.md"))).toBe(true);
    expect(wt.title).toBe("Make the header");
    expect(wt.linkPath).toBeUndefined(); // the directory is already named for the branch
    expect(w.agents.get(wt.id)?.sent[0]?.text).toBe("make the header sticky");
    expect(wt.promptedAt).toBeGreaterThan(0);
    expect(wt.agent).toBe("claude");
    await settle();
    expect(w.procs.get(wt.id)?.started.map((p) => p.name)).toEqual(["web"]);
  });

  test("gitignored local config is copied in, and an existing file is left alone", async () => {
    const repoId = await registered();
    writeFileSync(join(w.repo, ".dev.vars"), "AUTH_SECRET=frombase\n");
    writeFileSync(join(w.repo, ".env"), "API=base\n");
    const wt = await w.worktrees.create(repoId, "needs secrets");
    await settle();
    expect(readFileSync(join(wt.path, ".dev.vars"), "utf8")).toBe("AUTH_SECRET=frombase\n");
    expect(readFileSync(join(wt.path, ".env"), "utf8")).toBe("API=base\n");
    // a file the worktree already carries is never overwritten
    writeFileSync(join(wt.path, ".env"), "API=mine\n");
    await w.worktrees.setupAndStart(wt, w.state.repo(wt.repoId)!, w.repo);
    expect(readFileSync(join(wt.path, ".env"), "utf8")).toBe("API=mine\n");
  });

  // A worktree gets the branch's files, so a .gitignore nobody has committed is not among them,
  // and every ignored file in the tree (the deps copy first of all) reads as untracked work. The
  // rules are mirrored, not the file: a carried .gitignore would be untracked work of its own, and
  // a worktree with any is one land and sync both refuse.
  test("an uncommitted .gitignore is mirrored, so the deps copy is not untracked work", async () => {
    const repoId = await registered();
    writeFileSync(join(w.repo, ".gitignore"), "node_modules/\n");
    mkdirSync(join(w.repo, "node_modules"), { recursive: true });
    writeFileSync(join(w.repo, "node_modules", "dep.js"), "x\n");
    const wt = await w.worktrees.create(repoId, "task");
    await settle();
    expect(existsSync(join(wt.path, ".gitignore"))).toBe(false);
    expect(existsSync(join(wt.path, "node_modules", "dep.js"))).toBe(true);
    expect((await w.worktrees.gitStatus(wt.id))?.files).toEqual([]);
  });

  test("a second setup rewrites the mirrored block rather than stacking another", async () => {
    const repoId = await registered();
    writeFileSync(join(w.repo, ".gitignore"), "node_modules/\n");
    const wt = await w.worktrees.create(repoId, "task");
    await settle();
    writeFileSync(join(w.repo, ".gitignore"), "node_modules/\ndist/\n");
    await w.worktrees.setupAndStart(wt, w.state.repo(wt.repoId)!, w.repo);
    const text = readFileSync(join(w.repo, ".git/info/exclude"), "utf8");
    expect(text.match(/# toyon base \.gitignore$/gm)?.length).toBe(1);
    expect(text).toContain("dist/");
  });

  test("a committed .gitignore is the branch's own, and nothing is mirrored over it", async () => {
    const repoId = await registered();
    writeFileSync(join(w.repo, ".gitignore"), "dist/\n");
    sh(w.repo, GIT, "add", ".gitignore");
    sh(w.repo, GIT, "commit", "-qm", "ignore dist");
    const wt = await w.worktrees.create(repoId, "task");
    await settle();
    expect(readFileSync(join(w.repo, ".git/info/exclude"), "utf8")).not.toContain("dist/");
    expect(readFileSync(join(wt.path, ".gitignore"), "utf8")).toBe("dist/\n");
  });

  test("a main that git reads as bare refuses the create and makes no worktree", async () => {
    const repoId = await registered();
    sh(w.repo, "git", "config", "core.bare", "true");
    await expect(w.worktrees.create(repoId, "make the header sticky")).rejects.toBeInstanceOf(UserError);
    expect(w.state.worktrees.filter((x) => x.kind === "worktree")).toEqual([]);
  });

  test("create stamps the requested agent, else the daemon default; unknown ids are UserErrors", async () => {
    const repoId = await registered();
    expect((await w.worktrees.create(repoId, "a", { agent: "codex" })).agent).toBe("codex");
    w.state.setDefaultAgent("codex");
    expect((await w.worktrees.create(repoId, "b")).agent).toBe("codex");
    await expect(w.worktrees.create(repoId, "c", { agent: "nope" })).rejects.toBeInstanceOf(UserError);
  });

  test("remove stops the agent and procs, deletes the directory, branch and state row, and archives the transcript", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "task");
    await settle();
    // unmerged work on the branch: the confirm said it would be lost, so the delete is forced
    writeFileSync(join(wt.path, "new.txt"), "x\n");
    sh(wt.path, "git", "add", "new.txt");
    sh(wt.path, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "unmerged");
    writeFileSync(transcriptPathFor(w.paths.transcriptsDir, wt.id), "{}\n");
    await w.worktrees.archiveWorktree(wt.id);
    expect(w.agents.get(wt.id)?.closes).toBe(1);
    expect(w.procs.get(wt.id)?.stopped).toBe(true);
    expect(existsSync(wt.path)).toBe(false);
    expect(sh(w.repo, "git", "branch", "--list", wt.branch)).toBe("");
    expect(existsSync(transcriptPathFor(w.paths.transcriptsDir, wt.id))).toBe(false);
    expect(existsSync(join(w.paths.archiveDir, wt.id, "transcript.jsonl"))).toBe(true);
    expect(w.state.worktree(wt.id)).toBeUndefined();
    expect(w.runtime.get(wt.id)).toBeUndefined();
  });

  test("removing an adopted worktree keeps the person's branch", async () => {
    await registered();
    await settle();
    const wt = await adoptDir(foreignWorktree("theirs", "their-branch"));
    await settle();
    await w.worktrees.archiveWorktree(wt.id);
    expect(existsSync(wt.path)).toBe(false);
    expect(sh(w.repo, "git", "branch", "--list", "their-branch")).toBe("their-branch");
  });

  test("main cannot be removed", async () => {
    await registered();
    const main = w.state.worktrees.find((x) => x.kind === "main")!;
    await w.worktrees.archiveWorktree(main.id);
    expect(w.state.worktree(main.id)).toBeDefined();
  });

  // The remove empties the directory file by file and git answers honestly about a half-empty
  // tree, so mid-remove every file still in it reads as deleted: 15k of them on a 20k-file
  // worktree, which the panel drew as the whole repo being wiped. Nothing is read on the way out.
  test("a worktree on its way out is not read: no status frame, and no count for the rail", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "task");
    await settle();
    expect(await w.worktrees.gitStatus(wt.id)).not.toBeNull();
    const going = w.worktrees.archiveWorktree(wt.id);
    expect(await w.worktrees.gitStatus(wt.id)).toBeNull();
    expect(await w.worktrees.freshCounts(wt.id)).toEqual({});
    await going;
  });

  test("a discard is on its way out too, and no archive covers it", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "task");
    await settle();
    expect(await w.worktrees.gitStatus(wt.id)).not.toBeNull();
    const going = w.worktrees.discardWorktree(wt.id);
    expect(await w.worktrees.gitStatus(wt.id)).toBeNull();
    await going;
  });
});

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

  test("the warm spare is listed for the draft tab's preview, and leaves the list on claim", async () => {
    const repoId = await registered();
    await w.worktrees.spare.ensure(repoId);
    const spare = w.state.worktrees.find((x) => x.kind === "spare")!;
    expect(w.worktrees.spares()).toEqual([
      { repoId, id: spare.id, path: spare.path, proxyPort: spare.proxyPort, ready: true },
    ]);
    const wt = await w.worktrees.create(repoId, "use the spare");
    expect(w.worktrees.spares().some((s) => s.id === wt.id)).toBe(false);
    // the next one warms in the background and says so with a frame once it is ready
    let changed = 0;
    w.hub.on("worktreesChanged", () => changed++);
    await settle();
    await settle();
    const next = w.worktrees.spares().find((s) => s.repoId === repoId);
    expect(next?.id).not.toBe(wt.id);
    expect(next?.ready).toBe(true);
    expect(changed).toBeGreaterThan(0);
  });

  test("a claimed spare keeps its directory but gets a branch-named link that follows renames and removal", async () => {
    const repoId = await registered();
    await w.worktrees.spare.ensure(repoId);
    const wt = await w.worktrees.create(repoId, "use the spare");
    expect(wt.path.includes("wt-")).toBe(true);
    const first = wt.linkPath!;
    expect(first).toBe(join(dirname(wt.path), wt.branch.replace("toyon/", "")));
    expect(readlinkSync(first)).toBe(wt.path);
    await w.worktrees.rename(wt.id, "Better Name");
    // the title is read as it was typed; the branch and the link carry its slug
    expect(wt.title).toBe("Better Name");
    expect(wt.branch).toBe("toyon/better-name");
    expect(lstatSync(first, { throwIfNoEntry: false })).toBeUndefined();
    expect(wt.linkPath).toBe(join(dirname(wt.path), "better-name"));
    expect(readlinkSync(wt.linkPath!)).toBe(wt.path);
    const link = wt.linkPath!;
    await w.worktrees.archiveWorktree(wt.id);
    expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined();
  });

  test("worktrees sharing a title link by branch tail, so links never collide", async () => {
    const repoId = await registered();
    const a = await w.worktrees.create(repoId, "first task");
    const b = await w.worktrees.create(repoId, "second task");
    await w.worktrees.rename(a.id, "same");
    await w.worktrees.rename(b.id, "same");
    expect([a.title, b.title]).toEqual(["same", "same"]);
    expect(b.branch).toBe("toyon/same-2");
    expect(a.linkPath).toBe(join(dirname(a.path), "same"));
    expect(b.linkPath).toBe(join(dirname(b.path), "same-2"));
    expect(readlinkSync(b.linkPath!)).toBe(b.path);
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

  test("the spare's statuses row is hidden until claimed", async () => {
    const repoId = await registered();
    await w.worktrees.spare.ensure(repoId);
    expect((await w.worktrees.rows()).some((s) => s.worktree?.kind === "spare")).toBe(false);
  });
});

describe("confirmConfig", () => {
  test("restarts procs but keeps the same agent object", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "task");
    await settle();
    const agent = w.runtime.get(wt.id)!.agent;
    const procsBefore = w.procs.get(wt.id)!;
    await w.repos.confirmConfig(repoId, { run: { web: "true", api: "true" } }, "local");
    await settle();
    expect(w.runtime.get(wt.id)!.agent).toBe(agent);
    // an opened repo gets one person's file, which git does not list
    expect(w.state.requireRepo(repoId).configFile).toBe(".toyon/settings.local.json");
    expect(JSON.parse(readFileSync(join(w.repo, ".toyon/settings.local.json"), "utf8"))).toEqual({
      run: { web: "true", api: "true" },
    });
    expect((await git(w.repo, "status", "--porcelain")).out).toBe("");
    expect(procsBefore.stopped).toBe(true);
    expect(
      w.procs
        .get(wt.id)!
        .started.map((p) => p.name)
        .sort(),
    ).toEqual(["api", "web"]);
  });

  const excludes = () => readFileSync(join(w.repo, ".git/info/exclude"), "utf8");
  const untracked = async () => (await git(w.repo, "status", "--porcelain", "--untracked-files=all")).out;

  test("committed moves a local file into the shared one and lets git see it again", async () => {
    const repoId = await registered();
    await w.repos.confirmConfig(repoId, { run: { web: "true" } }, "local");
    expect(excludes()).toContain(".toyon/settings.local.json");
    await w.repos.confirmConfig(repoId, { run: { web: "true" }, setup: ["make"] }, "shared");
    expect(existsSync(join(w.repo, ".toyon/settings.local.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(w.repo, ".toyon/settings.json"), "utf8"))).toEqual({
      run: { web: "true" },
      setup: ["make"],
    });
    expect(w.state.requireRepo(repoId).configFile).toBe(".toyon/settings.json");
    // the exclude line goes with the file, so a local file written later by hand is excluded afresh
    expect(excludes()).not.toContain("settings.local.json");
    expect(await untracked()).toBe("?? .toyon/settings.json");
  });

  test("kept local moves a shared file nobody committed, and leaves one the team has", async () => {
    const repoId = await registered();
    mkdirSync(join(w.repo, ".toyon"));
    writeFileSync(join(w.repo, ".toyon/settings.json"), JSON.stringify({ run: { web: "true" } }));
    w.repos.reloadConfig(repoId);
    await w.repos.confirmConfig(repoId, { run: { web: "true", api: "true" } }, "local");
    expect(existsSync(join(w.repo, ".toyon/settings.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(w.repo, ".toyon/settings.local.json"), "utf8"))).toEqual({
      run: { web: "true", api: "true" },
    });
    expect(await untracked()).toBe("");

    // the same choice over a committed file is an override: the team's file is not ours to take
    writeFileSync(join(w.repo, ".toyon/settings.json"), JSON.stringify({ run: { web: "true" } }));
    sh(w.repo, GIT, "add", ".toyon/settings.json");
    sh(w.repo, GIT, "commit", "-q", "-m", "settings");
    await w.repos.confirmConfig(repoId, { run: { web: "true", api: "true" } }, "local");
    expect(JSON.parse(readFileSync(join(w.repo, ".toyon/settings.json"), "utf8"))).toEqual({ run: { web: "true" } });
    expect(JSON.parse(readFileSync(join(w.repo, ".toyon/settings.local.json"), "utf8"))).toEqual({
      run: { api: "true" },
    });
    expect(await untracked()).toBe("");
  });

  test("the choice keeps the place the settings already are in", async () => {
    const repoId = await registered();
    writeFileSync(join(w.repo, "toyon.local.json"), JSON.stringify({ run: { web: "true" } }));
    w.repos.reloadConfig(repoId);
    await w.repos.confirmConfig(repoId, { run: { web: "true" } }, "shared");
    expect(existsSync(join(w.repo, "toyon.local.json"))).toBe(false);
    expect(existsSync(join(w.repo, "toyon.json"))).toBe(true);
    expect(w.state.requireRepo(repoId).configFile).toBe("toyon.json");
  });
});

describe("profiles", () => {
  const profiled = {
    run: { api: "true", web: "true" },
    profiles: { full: { run: ["api", "web"] }, fe: { run: ["web"] } },
    defaultProfile: "fe",
  };
  async function registeredWithProfiles(): Promise<string> {
    const repoId = await registered();
    w.state.requireRepo(repoId).config = profiled;
    w.state.save();
    return repoId;
  }
  const names = (id: string) => w.procs.get(id)!.started.map((p) => p.name);

  test("create runs the requested profile; a claimed spare restarts under it and keeps its agent", async () => {
    const repoId = await registeredWithProfiles();
    await w.worktrees.spare.ensure(repoId);
    const spare = w.state.worktrees.find((x) => x.kind === "spare")!;
    expect(names(spare.id)).toEqual(["web"]); // warmed under the default
    const spareProcs = w.procs.get(spare.id)!;
    const spareAgent = w.agents.get(spare.id)!;
    const wt = await w.worktrees.create(repoId, "full stack task", { profile: "full" });
    await settle();
    expect(wt.id).toBe(spare.id);
    expect(wt.profile).toBe("full");
    expect(spareProcs.stopped).toBe(true);
    expect(names(wt.id)).toEqual(["api", "web"]);
    expect(w.runtime.get(wt.id)?.agent).toBe(spareAgent);
    expect(spareAgent.sent[0]?.text).toBe("full stack task");
    // the default profile claims without a restart
    await settle();
    const wt2 = await w.worktrees.create(repoId, "fe task");
    await settle();
    expect(wt2.profile).toBeUndefined();
    expect(w.procs.get(wt2.id)!.stopped).toBe(false);
  });

  test("an unknown profile is a UserError before anything is created", async () => {
    const repoId = await registeredWithProfiles();
    const before = w.state.worktrees.length;
    await expect(w.worktrees.create(repoId, "x", { profile: "nope" })).rejects.toBeInstanceOf(UserError);
    expect(w.state.worktrees.length).toBe(before);
    const wt = await w.worktrees.create(repoId, "x");
    expect(() => w.worktrees.setProfile(wt.id, "nope")).toThrow(UserError);
  });

  test("setProfile restarts only that worktree's procs and persists the choice", async () => {
    const repoId = await registeredWithProfiles();
    const a = await w.worktrees.create(repoId, "a");
    const b = await w.worktrees.create(repoId, "b");
    await settle();
    const aProcs = w.procs.get(a.id)!;
    const bProcs = w.procs.get(b.id)!;
    const agent = w.runtime.get(a.id)!.agent;
    w.worktrees.setProfile(a.id, "full");
    await settle();
    expect(a.profile).toBe("full");
    expect(aProcs.stopped).toBe(true);
    expect(names(a.id)).toEqual(["api", "web"]);
    expect(bProcs.stopped).toBe(false);
    expect(w.runtime.get(a.id)!.agent).toBe(agent);
    expect(w.state.worktree(a.id)?.profile).toBe("full");
    // same profile again: nothing happens
    const after = w.procs.get(a.id)!;
    w.worktrees.setProfile(a.id, "full");
    await settle();
    expect(w.procs.get(a.id)).toBe(after);
  });
});

describe("config reload", () => {
  test("a toyon.json edit becomes the config, restarts the repo's worktrees, and a broken edit is ignored", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "task");
    await settle();
    const procsBefore = w.procs.get(wt.id)!;
    let repos = 0;
    w.hub.on("reposChanged", () => repos++);
    writeFileSync(join(w.repo, "toyon.json"), JSON.stringify({ run: { web: "true", api: "true" } }));
    w.repos.reloadConfig(repoId);
    await settle();
    expect(w.state.requireRepo(repoId).config.run).toEqual({ web: "true", api: "true" });
    expect(procsBefore.stopped).toBe(true);
    expect(
      w.procs
        .get(wt.id)!
        .started.map((p) => p.name)
        .sort(),
    ).toEqual(["api", "web"]);
    expect(repos).toBe(1);

    const procsNow = w.procs.get(wt.id)!;
    const lines: string[] = [];
    w.hub.on("log", (_id, proc, line) => proc === "config" && lines.push(line));
    writeFileSync(join(w.repo, "toyon.json"), "{ broken");
    w.repos.reloadConfig(repoId);
    await settle();
    expect(w.state.requireRepo(repoId).config.run).toEqual({ web: "true", api: "true" });
    expect(w.procs.get(wt.id)).toBe(procsNow);
    expect(lines[0]).toMatch(/not valid JSON/);
    expect(repos).toBe(1);
  });

  test("a key toyon does not know is named in main's log, even when nothing else changed", async () => {
    const repoId = await registered();
    const lines: string[] = [];
    w.hub.on("log", (_id, proc, line) => proc === "config" && lines.push(line));
    writeFileSync(join(w.repo, "toyon.json"), JSON.stringify({ run: { web: "true" }, chek: "bun test" }));
    w.repos.reloadConfig(repoId);
    expect(w.state.requireRepo(repoId).config).toEqual({ run: { web: "true" } });
    expect(lines).toEqual(["ignoring toyon.json: chek, which Toyon does not know"]);
  });

  test("a file in .toyon/ is read like one at the root, and moving it there changes where a save goes", async () => {
    const repoId = await registered();
    writeFileSync(join(w.repo, "toyon.json"), JSON.stringify({ run: { web: "true" } }));
    w.repos.reloadConfig(repoId);
    expect(w.state.requireRepo(repoId).configFile).toBe("toyon.json");
    rmSync(join(w.repo, "toyon.json"));
    mkdirSync(join(w.repo, ".toyon"));
    writeFileSync(join(w.repo, ".toyon/settings.json"), JSON.stringify({ run: { web: "true", api: "true" } }));
    writeFileSync(join(w.repo, ".toyon/settings.local.json"), JSON.stringify({ run: { api: null } }));
    w.repos.reloadConfig(repoId);
    expect(w.state.requireRepo(repoId).config.run).toEqual({ web: "true" });
    expect(w.state.requireRepo(repoId).configFile).toBe(".toyon/settings.local.json");
    // a save over the shared file keeps only the difference, so the team's later edits still arrive
    await w.repos.confirmConfig(repoId, { run: { web: "true", api: "true" }, setup: ["make"] }, "local");
    expect(JSON.parse(readFileSync(join(w.repo, ".toyon/settings.local.json"), "utf8"))).toEqual({ setup: ["make"] });
    // one person's file is out of git, the shared one is not
    expect((await git(w.repo, "status", "--porcelain", "--untracked-files=all")).out).toBe("?? .toyon/settings.json");
  });

  test("boot picks up a toyon.json written while the daemon was down", async () => {
    const repoId = await registered();
    writeFileSync(join(w.repo, "toyon.json"), JSON.stringify({ run: { api: "true" } }));
    // a second registry over the same state, as a restart would build
    const again = new RepoRegistry({
      state: w.state,
      hub: w.hub,
      runtime: w.runtime,
      worktrees: w.worktrees,
      ...noSelf(w.state, w.hub),
    });
    await again.boot();
    again.stopWatchers();
    expect(w.state.requireRepo(repoId).config.run).toEqual({ api: "true" });
    expect(w.state.requireRepo(repoId).needsSetup).toBe(false);
  });
});

describe("empty tree", () => {
  test("main's record says whether the tree is empty; a task worktree never does", async () => {
    const repoId = await registered();
    const main = w.state.worktrees.find((x) => x.repoId === repoId && x.kind === "main")!;
    expect(main.empty).toBe(false);
    const wt = await w.worktrees.create(repoId, "task");
    await w.worktrees.gitStatus(wt.id);
    expect(w.state.requireWorktree(wt.id).empty).toBeUndefined();
  });

  test("a project made from the picker is empty until something lands in it, and the rows say so", async () => {
    const dir = join(dirname(w.repo), "fresh");
    sh(dirname(w.repo), "git", "init", "-q", "-b", "main", dir);
    sh(
      dir,
      "git",
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-qm",
      "initial commit",
    );
    const repo = await w.repos.register(dir);
    const main = w.state.worktrees.find((x) => x.repoId === repo.id && x.kind === "main")!;
    expect(main.empty).toBe(true);
    expect((await w.worktrees.rows({ quick: true })).find((r) => r.id === main.id)?.worktree?.empty).toBe(true);
    writeFileSync(join(dir, "index.html"), "<h1>hi</h1>\n");
    await w.worktrees.gitStatus(main.id);
    expect(w.state.requireWorktree(main.id).empty).toBe(false);
    // the same answer again is not a change (counted after the register's spare has settled,
    // since its own worktreesChanged lands whenever it likes)
    await settle();
    let changed = 0;
    w.hub.on("worktreesChanged", () => changed++);
    await w.worktrees.gitStatus(main.id);
    expect(changed).toBe(0);
  });
});

describe("quick rows", () => {
  test("answers from the caches without git, then queues the real pass", async () => {
    const repoId = await registered();
    const main = w.state.worktrees.find((x) => x.repoId === repoId && x.kind === "main")!;
    let changed = 0;
    w.hub.on("worktreesChanged", () => changed++);
    // nothing cached yet: the row comes back without counts and a pass is queued behind it
    const cold = await w.worktrees.rows({ quick: true });
    expect(cold.find((r) => r.id === main.id)?.dirty).toBeUndefined();
    await settle();
    expect(changed).toBe(1);
    // the full pass fills the cache; quick now answers with it and queues nothing
    const full = await w.worktrees.rows();
    expect(full.find((r) => r.id === main.id)?.dirty).toBe(0);
    const warm = await w.worktrees.rows({ quick: true });
    expect(warm.find((r) => r.id === main.id)?.dirty).toBe(0);
    await settle();
    expect(changed).toBe(1);
  });
});

describe("redetect at turn end", () => {
  const turnEnd = (id: string) => w.hub.emit("agent", id, 0, { type: "turn-end", stopReason: "end_turn", ts: 0 });

  test("a scaffold that detection recognises becomes the guess, still unconfirmed", async () => {
    const repo = await w.repos.register(w.repo);
    const main = w.state.worktrees.find((x) => x.repoId === repo.id && x.kind === "main")!;
    expect(repo.needsSetup).toBe(true);
    let repos = 0;
    w.hub.on("reposChanged", () => repos++);
    writeFileSync(join(w.repo, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    writeFileSync(join(w.repo, "bun.lock"), "");
    turnEnd(main.id);
    expect(w.state.requireRepo(repo.id).config).toEqual({
      run: { web: "bun run dev --port $PORT --strictPort" },
      setup: ["bun install"],
    });
    expect(w.state.requireRepo(repo.id).needsSetup).toBe(true);
    expect(repos).toBe(1);
    // the same tree again says nothing new
    turnEnd(main.id);
    expect(repos).toBe(1);
  });

  test("a build file with no page is assumed until a scaffold or a saved setup says otherwise", async () => {
    writeFileSync(join(w.repo, "Cargo.toml"), '[package]\nname = "tool"\n');
    const repo = await w.repos.register(w.repo);
    const main = w.state.worktrees.find((x) => x.repoId === repo.id && x.kind === "main")!;
    expect(repo).toMatchObject({ needsSetup: true, assumed: "Cargo.toml", config: { run: {} } });
    // the agent scaffolds a front end beside it: its start command is the guess, and setup is asked again
    writeFileSync(join(w.repo, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    turnEnd(main.id);
    expect(w.state.requireRepo(repo.id).assumed).toBeUndefined();
    expect(w.state.requireRepo(repo.id).guess).toBe("package.json");
    rmSync(join(w.repo, "package.json"));
    turnEnd(main.id);
    expect(w.state.requireRepo(repo.id).assumed).toBe("Cargo.toml");
    // saving setup confirms it and ends the assumption
    await w.repos.confirmConfig(repo.id, { run: {} }, "local");
    expect(w.state.requireRepo(repo.id)).toMatchObject({ needsSetup: false, config: { run: {} } });
    expect(w.state.requireRepo(repo.id).assumed).toBeUndefined();
  });

  test("a toyon.json the agent wrote applies at once, like a hand-written one", async () => {
    const repo = await w.repos.register(w.repo);
    const main = w.state.worktrees.find((x) => x.repoId === repo.id && x.kind === "main")!;
    writeFileSync(join(w.repo, "toyon.json"), JSON.stringify({ run: { web: "true" } }));
    turnEnd(main.id);
    expect(w.state.requireRepo(repo.id).needsSetup).toBe(false);
    expect(w.state.requireRepo(repo.id).config.run).toEqual({ web: "true" });
  });

  test("a confirmed repo keeps its config whatever lands in the tree", async () => {
    const repoId = await registered();
    const main = w.state.worktrees.find((x) => x.repoId === repoId && x.kind === "main")!;
    writeFileSync(join(w.repo, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    turnEnd(main.id);
    expect(w.state.requireRepo(repoId).config).toEqual({ run: { web: "true" } });
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

describe("landing", () => {
  /** the subjects on main, newest first */
  const subjects = async () => (await git(w.repo, "log", "--format=%s", "-n", "6")).out.split("\n");
  /** how many parents main's tip has: two for a merge commit, one otherwise */
  const parents = async () => (await git(w.repo, "log", "-1", "--format=%P")).out.split(" ").filter(Boolean).length;

  test("a committed branch lands under a merge commit, marks landed, and restarts from main", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    expect((await w.worktrees.commit(wt.id, "add feature")).ok).toBe(true);
    const { result, archiveIds } = await w.worktrees.land(wt.id);
    expect(result.ok).toBe(true);
    expect(archiveIds).toEqual([]);
    expect(existsSync(join(w.repo, "feature.txt"))).toBe(true);
    expect(await parents()).toBe(2);
    expect((await git(w.repo, "log", "-1", "--format=%s", "main^2")).out).toBe("add feature");
    expect(w.state.worktree(wt.id)?.landed).toBe(true);
    // the branch now equals main: nothing ahead, nothing behind, a clean base for what comes next
    expect((await git(wt.path, "rev-parse", "HEAD")).out).toBe((await git(w.repo, "rev-parse", "main")).out);
    // new work clears the badge through gitStatus
    writeFileSync(join(wt.path, "more.txt"), "y\n");
    await w.worktrees.gitStatus(wt.id);
    expect(w.state.worktree(wt.id)?.landed).toBe(false);
  });

  /** a pre-commit hook for the repo that prints its complaint and refuses; repo-local hooksPath so
   * a global one on this machine does not stand in for it */
  const refusingHook = (lines: string[]) => {
    const hooks = join(w.repo, ".toyon-test-hooks");
    mkdirSync(hooks, { recursive: true });
    const body = lines.map((l) => `echo ${JSON.stringify(l)}`).join("\n");
    writeFileSync(join(hooks, "pre-commit"), `#!/bin/sh\n${body}\necho "and on stderr" 1>&2\nexit 1\n`, {
      mode: 0o755,
    });
    sh(w.repo, "git", "config", "core.hooksPath", hooks);
  };
  const recorded = (id: string) => (w.runtime.agentFor(id) as unknown as FakeAgent).recorded;

  test("a commit a hook refuses goes on the transcript whole, as the rows a ! command leaves", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    refusingHook(["a dash in copy: src/x.ts:3", "one file rejected"]);
    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    const result = await w.worktrees.commit(wt.id, "add feature\n\nwith a body");
    expect(result.ok).toBe(false);
    expect(result.message).toBe("commit refused: what git and its hooks printed is on the chat");
    const rows = recorded(wt.id);
    expect(rows.map((e) => e.type)).toEqual(["tool-start", "tool-end"]);
    const start = rows[0];
    expect(start?.type === "tool-start" && start.name === SHELL_TOOL && start.input).toEqual({
      command: 'git commit -m "add feature"',
    });
    const end = rows[1];
    expect(end?.type === "tool-end" && end.isError).toBe(true);
    expect(end?.type === "tool-end" && end.output).toBe(
      "```\na dash in copy: src/x.ts:3\none file rejected\nand on stderr\n```\nexit 1",
    );
    // land's commit step is the same commit: refused the same way, and nothing lands
    const landed = await w.worktrees.land(wt.id, "add feature");
    expect(landed.result.ok).toBe(false);
    expect(recorded(wt.id).map((e) => e.type)).toEqual(["tool-start", "tool-end", "tool-start", "tool-end"]);
    expect(existsSync(join(w.repo, "feature.txt"))).toBe(false);
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
    expect(result.conflict).toBe(true);
    expect((await git(wt.path, "status", "--porcelain")).out).toBe("");
    expect(readFileSync(join(wt.path, "README.md"), "utf8")).toBe("theirs\n");
    expect((await git(wt.path, "log", "-1", "--format=%s")).out).toBe("theirs");
  });

  test("the push route pushes main to origin, and refuses when origin moved under it", async () => {
    const repoId = await registered();
    const origin = join(w.repo, "..", "origin.git");
    // -b main: a clone of origin checks out its HEAD, which is init.defaultBranch unless named
    sh(w.repo, "git", "init", "-q", "--bare", "-b", "main", origin);
    sh(w.repo, "git", "remote", "add", "origin", origin);
    sh(w.repo, "git", "push", "-q", "-u", "origin", "main");
    w.state.requireRepo(repoId).config.land = { route: "push" };
    const wt = await w.worktrees.create(repoId, "feature");
    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    const { result } = await w.worktrees.land(wt.id, "add feature");
    expect(result.ok).toBe(true);
    expect(result.message).toContain("pushed");
    expect((await git(origin, "log", "-1", "--format=%s", "main^2")).out).toBe("add feature");
    // origin moves on through someone else; the next land takes it in first and still pushes
    const other = join(w.repo, "..", "other");
    sh(w.repo, "git", "clone", "-q", origin, other);
    sh(other, "git", "config", "user.email", "o@o");
    sh(other, "git", "config", "user.name", "o");
    sh(other, "git", "commit", "-q", "--allow-empty", "-m", "elsewhere");
    sh(other, "git", "push", "-q", "origin", "main");
    writeFileSync(join(wt.path, "more.txt"), "y\n");
    const again = await w.worktrees.land(wt.id, "add more");
    expect(again.result.ok).toBe(true);
    expect((await git(origin, "log", "--format=%s", "-n", "5")).out.split("\n")).toContain("elsewhere");
  });

  test("the pr route refuses without an origin", async () => {
    const repoId = await registered();
    w.state.requireRepo(repoId).config.land = { route: "pr" };
    const wt = await w.worktrees.create(repoId, "feature");
    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    const { result } = await w.worktrees.land(wt.id, "add feature");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("no 'origin' remote");
    // the commit stood: the work is safer committed
    expect((await git(wt.path, "status", "--porcelain")).out).toBe("");
  });

  test("land commits with the message it is given and merges; the worktree stays, marked landed", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    w.worktrees.setLanding(wt.id, { at: 1, check: "pass", ready: true, subject: "old words", fingerprint: "f" });
    const { result, archiveIds } = await w.worktrees.land(wt.id, "add feature\n\nOne file.");
    expect(result.ok).toBe(true);
    expect(result.message).toBe(`${wt.title} is on main`);
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

  test("land syncs main in first when the branch is behind, and a dirty main checkout refuses", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    sh(w.repo, "git", "commit", "--allow-empty", "-qm", "main moves on");
    writeFileSync(join(w.repo, "README.md"), "edited on main\n");
    const refused = await w.worktrees.land(wt.id, "add feature");
    expect(refused.result.ok).toBe(false);
    expect(refused.result.message).toContain("uncommitted changes");
    // the commit stood: the work is safer committed, and the worktree is still there to try again
    expect(w.state.worktree(wt.id)).toBeDefined();
    expect((await git(wt.path, "status", "--porcelain")).out).toBe("");
    sh(w.repo, "git", "checkout", "-q", "--", "README.md");
    const { result } = await w.worktrees.land(wt.id);
    expect(result.ok).toBe(true);
    expect((await git(w.repo, "log", "--format=%s", "-n", "4")).out.split("\n")).toContain("main moves on");
  });

  test("a status read retires a verdict once the tree no longer matches it", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    const fingerprint = (await import("../git/status.ts")).treeFingerprint;
    w.worktrees.setLanding(wt.id, {
      at: 1,
      check: "none",
      ready: true,
      subject: "add the feature",
      fingerprint: await fingerprint(wt.path),
    });
    await w.worktrees.gitStatus(wt.id);
    expect(w.state.worktree(wt.id)?.landing?.ready).toBe(true);
    writeFileSync(join(wt.path, "feature.txt"), "x\ny\n");
    await w.worktrees.gitStatus(wt.id);
    expect(w.state.worktree(wt.id)?.landing).toBeUndefined();
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
    expect(result.conflict).toBe(true);
    expect((await git(wt.path, "status", "--porcelain")).out).toBe("");
    expect(readFileSync(join(wt.path, "README.md"), "utf8")).toBe("theirs\n");
  });

  test("commit with an empty message is a UserError", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    await expect(w.worktrees.commit(wt.id, "  ")).rejects.toBeInstanceOf(UserError);
  });

  // the rail's badges come from rows(), which caches counts for 10s; a landing op that moves
  // the worktree's own HEAD has to drop that entry and push a frame, or the rail keeps showing the
  // count the person just acted on
  test("sync and commit refresh the badge counts at once and push a worktrees frame", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    // create's setup and procs run behind it, and runtime.start emits once the proxy is up; a frame
    // from that landing inside a sync or commit below would be counted as theirs
    await until(() => w.runtime.get(wt.id)?.proxy != null);
    let frames = 0;
    w.hub.on("worktreesChanged", () => frames++);
    const row = async () => (await w.worktrees.rows()).find((s) => s.id === wt.id)!;

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

describe("open a ref", () => {
  test("a local branch becomes a worktree toyon owns, on that branch, with no prompt sent", async () => {
    const repoId = await registered();
    sh(w.repo, "git", "branch", "feat", "main");
    const wt = await w.worktrees.openRef(repoId, "branch", "feat", { createdBy: "tab" });
    await settle();
    expect(wt).toMatchObject({ kind: "worktree", branch: "feat", title: "feat", createdBy: "tab" });
    expect(wt.from).toEqual({ kind: "branch", ref: "feat" });
    expect(wt.path.startsWith(w.paths.worktreesDir)).toBe(true);
    expect((await git(wt.path, "branch", "--show-current")).out).toBe("feat");
    expect(w.procs.get(wt.id)?.started.map((p) => p.name)).toEqual(["web"]);
    expect(w.agents.get(wt.id)?.sent ?? []).toEqual([]);
    // nothing was sent, so it sorts by when it was made
    expect(wt.promptedAt).toBeUndefined();
    // a branch has one worktree: opening it again says where it already is
    await expect(w.worktrees.openRef(repoId, "branch", "feat")).rejects.toBeInstanceOf(UserError);
  });

  test("a remote branch is opened tracking its remote, and a PR from the remote's refs/pull", async () => {
    const repoId = await registered();
    // a local "origin" with a branch and a PR head that this repo does not have
    const origin = join(dirname(w.repo), "origin.git");
    sh(dirname(w.repo), "git", "clone", "-q", "--bare", w.repo, origin);
    sh(w.repo, "git", "remote", "add", "origin", origin);
    sh(w.repo, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "theirs");
    sh(w.repo, "git", "push", "-q", "origin", "main:refs/heads/theirs", "main:refs/pull/7/head");
    sh(w.repo, "git", "reset", "-q", "--hard", "HEAD~1");
    sh(w.repo, "git", "fetch", "-q", "origin");

    const remote = await w.worktrees.openRef(repoId, "remote", "theirs");
    expect(remote.from).toEqual({ kind: "remote", ref: "theirs" });
    expect((await git(remote.path, "rev-parse", "--abbrev-ref", "theirs@{u}")).out).toBe("origin/theirs");

    const pr = await w.worktrees.openRef(repoId, "pr", "7", { pr: { title: "Seven", url: "https://x/pull/7" } });
    expect(pr).toMatchObject({ branch: "pr/7", title: "pr-7" });
    expect(pr.from).toEqual({ kind: "pr", ref: "7", pr: { number: 7, title: "Seven", url: "https://x/pull/7" } });
    expect((await git(pr.path, "log", "-1", "--format=%s")).out).toBe("theirs");
    // a review is landed upstream, not here
    await expect(w.worktrees.land(pr.id)).rejects.toBeInstanceOf(UserError);
    await expect(w.worktrees.openRef(repoId, "pr", "x")).rejects.toBeInstanceOf(UserError);
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
      ...f2.factories,
    });
    const worktrees2 = new WorktreeService({
      state: state2,
      hub: hub2,
      runtime: runtime2,
      paths: w.paths,
      agents: w.registry,
      namer: async () => null,
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
    // boot starts nothing; opening main is what starts it, and only it
    const main = state2.worktrees.find((x) => x.kind === "main")!;
    const adopted = state2.worktrees.find((x) => x.kind === "spare")!;
    expect(runtime2.get(main.id)?.procs ?? null).toBeNull();
    repos2.touch(main.id);
    await settle();
    expect(runtime2.get(main.id)?.procs).toBeTruthy();
    expect(runtime2.get(adopted.id)?.procs ?? null).toBeNull();
    // the adopted spare comes back warm once the repo is in use: procs up, so the draft tab has a
    // preview and a claim hands over a running worktree
    repos2.warm(repoId);
    await settle();
    await settle();
    expect(runtime2.get(adopted.id)?.procs).toBeTruthy();
    expect(worktrees2.spares()).toEqual([
      { repoId, id: adopted.id, path: adopted.path, proxyPort: adopted.proxyPort, ready: true },
    ]);
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
        ...f2.factories,
      });
      const worktrees2 = new WorktreeService({
        state: state2,
        hub: hub2,
        runtime: runtime2,
        paths: w.paths,
        agents: w.registry,
        namer: async () => null,
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

// a worktree someone made in a terminal, which is the whole reason discovery exists
function foreignWorktree(name: string, branch: string): string {
  const dir = join(dirname(w.repo), name);
  sh(w.repo, "git", "worktree", "add", "-q", "-b", branch, dir, "main");
  w.worktrees.invalidateDiscovered();
  return dir;
}

/** the id the row at this directory was pushed with; adopt is addressed by it. A directory that
 * was never a worktree has no row, and an id nothing resolves is what the shell would send then. */
async function foundId(dir: string): Promise<string> {
  w.worktrees.invalidateDiscovered();
  const want = existsSync(dir) ? realpathSync(dir) : dir;
  const row = (await w.worktrees.discovered()).find((r) => realpathSync(r.path) === want);
  return row?.id ?? "nope";
}
const adoptDir = async (dir: string, createdBy?: string) => w.worktrees.adopt(await foundId(dir), createdBy);

describe("discovery", () => {
  test("a worktree made behind toyon's back is discovered", async () => {
    const repoId = await registered();
    await settle(); // the spare warms in the background and must not read as a stray
    const dir = foreignWorktree("outside", "made-elsewhere");

    const rows = await w.worktrees.discovered();
    expect(rows.map((r) => r.name)).toEqual(["made-elsewhere"]);
    expect(rows[0]?.repoId).toBe(repoId);
    expect(rows[0]?.branch).toBe("made-elsewhere");
    expect(existsSync(dir)).toBe(true);
  });

  test("rows() lists toyon's own first, then what it found, with counts on both", async () => {
    const repoId = await registered();
    const task = await w.worktrees.create(repoId, "mine");
    await settle();
    const dir = foreignWorktree("theirs", "their-branch");
    writeFileSync(join(dir, "wip.txt"), "x\n");
    sh(dir, "git", "add", "wip.txt");
    sh(dir, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "theirs");
    writeFileSync(join(dir, "dirty.txt"), "y\n");
    const rows = await w.worktrees.rows();
    const found = rows.at(-1)!;
    expect(rows.slice(0, -1).every((r) => r.worktree)).toBe(true);
    expect(rows.some((r) => r.id === task.id)).toBe(true);
    expect(found.worktree).toBeUndefined();
    expect(found).toMatchObject({ name: "their-branch", branch: "their-branch", procs: [], agent: "idle" });
    expect(found.ahead).toBe(1);
    expect(found.dirty).toBe(1);
  });

  test("toyon's own worktrees never appear, spare included", async () => {
    const repoId = await registered();
    await w.worktrees.create(repoId, "some task");
    await settle();
    w.worktrees.invalidateDiscovered();
    expect(await w.worktrees.discovered()).toEqual([]);
  });

  test("the list is cached until something invalidates it", async () => {
    await registered();
    await settle();
    expect(await w.worktrees.discovered()).toEqual([]);
    const dir = join(dirname(w.repo), "cached");
    sh(w.repo, "git", "worktree", "add", "-q", "-b", "cached-branch", dir, "main");
    // no invalidation: statuses() runs on every proc event and must not re-shell for each one
    expect(await w.worktrees.discovered()).toEqual([]);
    w.worktrees.invalidateDiscovered();
    expect((await w.worktrees.discovered()).map((r) => r.name)).toEqual(["cached-branch"]);
  });
});

describe("adopt", () => {
  test("take-over records it, starts its procs, and drops it from discovered", async () => {
    await registered();
    await settle();
    const dir = foreignWorktree("takeover", "take-me");

    const wt = await adoptDir(dir);
    expect(wt.kind).toBe("worktree");
    expect(wt.branch).toBe("take-me");
    expect(wt.title).toBe("take-me");
    expect(wt.proxyPort).toBeGreaterThan(0);
    await settle();

    const rows = await w.worktrees.rows();
    expect(rows.find((s) => s.id === wt.id)?.worktree).toBe(wt);
    expect(rows.every((s) => s.worktree)).toBe(true);
    expect(await w.worktrees.discovered()).toEqual([]);
    expect(w.procs.get(wt.id)?.started.map((p) => p.name)).toEqual(["web"]);
    // take-over is not a task: no prompt goes anywhere
    expect(w.agents.get(wt.id)?.sent ?? []).toEqual([]);
  });

  test("an adopted worktree keeps its branch name: rename refuses rather than moving it under toyon/", async () => {
    await registered();
    await settle();
    const wt = await adoptDir(foreignWorktree("theirs", "their-branch"));
    await expect(w.worktrees.rename(wt.id, "mine now")).rejects.toBeInstanceOf(UserError);
    expect(wt.branch).toBe("their-branch");
    expect(wt.title).toBe("their-branch");
  });

  test("a clean found worktree behind main syncs without take-over; a dirty one is refused untouched", async () => {
    const repoId = await registered();
    await settle();
    const dir = foreignWorktree("behind", "their-branch");
    const id = await foundId(dir);
    writeFileSync(join(w.repo, "newer.txt"), "x\n");
    sh(w.repo, "git", "add", "newer.txt");
    sh(w.repo, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "main moved");
    expect((await w.worktrees.gitStatus(id))?.behind).toBe(1);
    // dirty: refused before anything happens, and not as a conflict
    writeFileSync(join(dir, "wip.txt"), "y\n");
    const dirty = await w.worktrees.sync(id);
    expect(dirty.result.ok).toBe(false);
    expect(dirty.result.conflict).toBeUndefined();
    expect(existsSync(join(dir, "newer.txt"))).toBe(false);
    // clean: main comes in, and the row is still not toyon's
    rmSync(join(dir, "wip.txt"));
    const { result } = await w.worktrees.sync(id);
    expect(result.ok).toBe(true);
    expect(existsSync(join(dir, "newer.txt"))).toBe(true);
    expect((await w.worktrees.gitStatus(id))?.behind).toBe(0);
    expect(w.state.worktrees.some((x) => x.branch === "their-branch")).toBe(false);
    // main is its own baseline, and a held worktree is someone else's
    const main = w.state.worktrees.find((x) => x.repoId === repoId && x.kind === "main")!;
    await expect(w.worktrees.sync(main.id)).rejects.toBeInstanceOf(UserError);
    sh(w.repo, "git", "worktree", "lock", "--reason", "claude session (pid 1)", dir);
    w.worktrees.invalidateDiscovered();
    await expect(w.worktrees.sync(await foundId(dir))).rejects.toBeInstanceOf(UserError);
  });

  test("adopting a row toyon already owns, or an id nothing resolves, is a toast", async () => {
    const repoId = await registered();
    const task = await w.worktrees.create(repoId, "mine");
    await expect(w.worktrees.adopt(task.id)).rejects.toBeInstanceOf(UserError);
    await expect(w.worktrees.adopt("disc-000000000000")).rejects.toBeInstanceOf(UserError);
  });

  test("it does not run the repo's setup commands in a directory someone is using", async () => {
    const repoId = await registered();
    const repo = w.state.requireRepo(repoId);
    repo.config = { ...repo.config, setup: ["touch SETUP_RAN"] };
    w.state.save();
    await settle();
    const dir = foreignWorktree("nosetup", "no-setup");

    const wt = await adoptDir(dir);
    await settle();
    expect(existsSync(join(wt.path, "SETUP_RAN"))).toBe(false);
  });

  test("no stray symlink is planted beside it, on adopt or on the next boot", async () => {
    await registered();
    await settle();
    const dir = foreignWorktree("linkless", "editor-pane");

    const wt = await adoptDir(dir);
    await settle();
    expect(wt.linkPath).toBeUndefined();
    // the name refreshLink would otherwise have chosen: <parent>/<branch>
    expect(existsSync(join(dirname(dir), "editor-pane"))).toBe(false);

    // the constructor re-links every worktree at boot, so this has to survive a restart
    new WorktreeService({
      state: w.state,
      hub: w.hub,
      runtime: w.runtime,
      paths: w.paths,
      agents: w.registry,
      namer: async () => null,
    });
    expect(existsSync(join(dirname(dir), "editor-pane"))).toBe(false);
  });

  test("a locked worktree belongs to whoever locked it", async () => {
    await registered();
    await settle();
    const dir = foreignWorktree("locked", "held");
    sh(w.repo, "git", "worktree", "lock", "--reason", "claude session dsys (pid 900)", dir);
    w.worktrees.invalidateDiscovered();

    expect(adoptDir(dir)).rejects.toThrow(UserError);
    expect(w.state.worktrees.some((x) => x.branch === "held")).toBe(false);
  });

  test("a worktree nested inside the repo would run its procs in the main checkout", async () => {
    await registered();
    await settle();
    const inside = join(w.repo, "nested");
    sh(w.repo, "git", "worktree", "add", "-q", "-b", "nested-branch", inside, "main");
    w.worktrees.invalidateDiscovered();

    expect(adoptDir(inside)).rejects.toThrow(UserError);
  });

  test("a detached worktree has no branch to land or ship", async () => {
    await registered();
    await settle();
    const dir = join(dirname(w.repo), "loose");
    sh(w.repo, "git", "worktree", "add", "-q", "--detach", dir, "main");
    w.worktrees.invalidateDiscovered();

    expect(adoptDir(dir)).rejects.toThrow(UserError);
  });

  test("a path toyon was never offered is refused", async () => {
    await registered();
    await settle();
    expect(adoptDir(join(dirname(w.repo), "never-existed"))).rejects.toThrow(UserError);
  });
});

describe("a shell at a discovered worktree", () => {
  test("opens at its path, with no runtime and no agent behind it", async () => {
    await registered();
    await settle();
    const dir = foreignWorktree("shellhere", "shell-here");
    const [row] = await w.worktrees.discovered();

    w.runtime.openLooseShell(row!.id, row!.path, 80, 24);
    const term = w.terminals.get(row!.id)?.[0];
    // git reports the real directory, so the shell lands there rather than on the /var symlink
    expect(term?.opts.cwd).toBe(realpathSync(dir));
    // nothing else was spun up for it: a discovered worktree runs nothing
    expect(w.agents.get(row!.id)).toBeUndefined();
    expect(w.procs.get(row!.id)).toBeUndefined();
    expect(w.runtime.get(row!.id)).toBeUndefined();
  });

  test("the same directory keeps its shell across re-derivations", async () => {
    await registered();
    await settle();
    foreignWorktree("stable", "stable-branch");
    const first = (await w.worktrees.discovered())[0]!;
    w.runtime.openLooseShell(first.id, first.path, 80, 24);

    w.worktrees.invalidateDiscovered();
    const again = (await w.worktrees.discovered())[0]!;
    expect(again.id).toBe(first.id);
    w.runtime.openLooseShell(again.id, again.path, 80, 24);
    // reused, not respawned: the id is derived from the path, so the stream key held
    expect(w.terminals.get(first.id)?.length).toBe(1);
  });

  test("taking the worktree over takes the loose shell with it", async () => {
    await registered();
    await settle();
    const dir = foreignWorktree("adoptshell", "adopt-shell");
    const row = (await w.worktrees.discovered())[0]!;
    w.runtime.openLooseShell(row.id, row.path, 80, 24);
    expect(w.runtime.looseShell(row.id)).toBeDefined();

    await adoptDir(dir);
    await w.worktrees.discovered(); // the derivation that no longer lists it prunes the shell
    expect(w.runtime.looseShell(row.id)).toBeUndefined();
    expect(w.terminals.get(row.id)?.[0]?.alive).toBe(false);
  });
});

describe("main against origin", () => {
  /** a bare "origin" the repo tracks, with main one commit ahead of the checkout */
  async function withUpstream(): Promise<string> {
    const repoId = await registered();
    const bare = join(dirname(w.repo), "origin.git");
    sh(w.repo, "git", "init", "-q", "--bare", bare);
    sh(w.repo, "git", "remote", "add", "origin", bare);
    sh(w.repo, "git", "commit", "--allow-empty", "-qm", "upstream moves on");
    sh(w.repo, "git", "push", "-q", "-u", "origin", "main");
    sh(w.repo, "git", "reset", "-q", "--hard", "HEAD~1");
    return repoId;
  }

  test("main's row counts what it trails on origin; a worktree's row still counts against main", async () => {
    const repoId = await withUpstream();
    const wt = await w.worktrees.create(repoId, "feature");
    w.worktrees.invalidateCounts();
    const rows = await w.worktrees.rows();
    const main = rows.find((r) => r.worktree && r.worktree.kind === "main")!;
    expect(main.behind).toBe(1);
    expect(main.ahead).toBeUndefined();
    expect(rows.find((r) => r.id === wt.id)?.behind).toBe(0);
  });

  test("a main with no upstream has no count", async () => {
    await registered();
    const main = (await w.worktrees.rows()).find((r) => r.worktree && r.worktree.kind === "main")!;
    expect(main.behind).toBeUndefined();
  });

  test("pull fast-forwards main and every worktree's count moves with it", async () => {
    const repoId = await withUpstream();
    const wt = await w.worktrees.create(repoId, "feature");
    const main = w.state.worktrees.find((x) => x.repoId === repoId && x.kind === "main")!;
    // after the setup, or its own frame lands in the count and the pull is blamed for it
    await settle();
    let frames = 0;
    w.hub.on("worktreesChanged", () => frames++);
    const result = await w.worktrees.pull(main.id);
    expect(result).toMatchObject({ ok: true, message: "pulled 1 commit(s) from origin" });
    expect(frames).toBe(1);
    const rows = await w.worktrees.rows();
    expect(rows.find((r) => r.id === main.id)?.behind).toBe(0);
    expect(rows.find((r) => r.id === wt.id)?.behind).toBe(1);
    expect((await w.worktrees.pull(main.id)).message).toBe("already up to date with origin");
  });

  test("pull refuses a dirty main and a worktree, and says why", async () => {
    const repoId = await withUpstream();
    const wt = await w.worktrees.create(repoId, "feature");
    const main = w.state.worktrees.find((x) => x.repoId === repoId && x.kind === "main")!;
    writeFileSync(join(w.repo, "wip.txt"), "x\n");
    expect((await w.worktrees.pull(main.id)).ok).toBe(false);
    await expect(w.worktrees.pull(wt.id)).rejects.toBeInstanceOf(UserError);
  });
});

describe("usage on the row", () => {
  test("the stream's last figures ride on the row, and a cold worktree's come from its transcript", async () => {
    const repoId = await registered();
    const wt = await w.worktrees.create(repoId, "feature");
    expect((await w.worktrees.rows()).find((r) => r.id === wt.id)?.usage).toBeUndefined();
    w.hub.emit("agent", wt.id, 1, { type: "usage", used: 1000, size: 4000, cost: 0.2, ts: 0 });
    expect((await w.worktrees.rows()).find((r) => r.id === wt.id)?.usage).toEqual({
      used: 1000,
      size: 4000,
      cost: 0.2,
    });

    // a second service over the same state and files: the figures come from the transcript
    const cold = await w.worktrees.create(repoId, "cold");
    writeFileSync(
      transcriptPathFor(w.paths.transcriptsDir, cold.id),
      [
        JSON.stringify({ seq: 0, event: { type: "usage", used: 500, size: 4000, cost: 0.05, ts: 0 } }),
        JSON.stringify({ seq: 1, event: { type: "text-delta", text: "later" } }),
        JSON.stringify({ seq: 2, event: { type: "usage", used: 900, size: 4000, ts: 0 } }),
        "",
      ].join("\n"),
    );
    const again = new WorktreeService({
      state: w.state,
      hub: w.hub,
      runtime: w.runtime,
      paths: w.paths,
      agents: w.registry,
      namer: async () => null,
    });
    expect((await again.rows()).find((r) => r.id === cold.id)?.usage).toEqual({ used: 900, size: 4000 });
  });
});
