import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, PieceOutcome, RepoInfo } from "@toyon/shared";
import type { FakeAgent } from "../../test/helpers/fakes.ts";
import { sh } from "../../test/helpers/tmp-repo.ts";
import { planReader, registered, settle, until, useWorld, w } from "../../test/helpers/world.ts";
import { briefsDoc, writePlanDocNow } from "../agent/planDoc.ts";
import { StateStore } from "../core/state.ts";
import { GIT } from "../git/exec.ts";
import { listFile, PIECES_MAX, type RawPiece, sectionText } from "./pieces.ts";

// A plan's pieces across worktrees: the tool's answers to the agent, the list's state on the
// origin's transcript, what go makes, queues and sends, and the word back when a sibling lands.

useWorld();

type Proposed = Extract<AgentEvent, { type: "pieces-proposed" }>;
const agentOf = (id: string) => w.runtime.agentFor(id) as FakeAgent;
const recorded = (id: string, type: AgentEvent["type"]) => agentOf(id).recorded.filter((e) => e.type === type);
const lastProposal = (id: string) => agentOf(id).recorded.findLast((e) => e.type === "pieces-proposed") as Proposed;
const outcomesOf = (id: string) =>
  (agentOf(id).recorded.findLast((e) => e.type === "pieces") as Extract<AgentEvent, { type: "pieces" }>).outcomes;
const madeTitled = (title: string) => w.state.worktrees.find((x) => x.kind === "worktree" && x.title === title);

/** other projects made for a test, taken down with it */
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** a second project open beside the world's own, under a name of the test's choosing (the
 * world's is `repo`, which is a checkout's directory name like any other) */
async function otherProject(name: string): Promise<RepoInfo> {
  const root = mkdtempSync(join(tmpdir(), "toyon-pieces-"));
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

/** a commit on the worktree and its landing, through the service, as a person's land goes */
async function land(id: string, file: string) {
  const wt = w.state.worktree(id)!;
  writeFileSync(join(wt.path, file), "x\n");
  expect((await w.worktrees.commit(id, `add ${file}`)).ok).toBe(true);
  expect((await w.worktrees.land(id)).result.ok).toBe(true);
}

const HELD =
  "Handed to the person; the list shows beside your plan and they decide where each piece goes. Ask for plan approval now.";
const SHOWN = "Handed to the person as a card; they decide. Finish your turn.";

const piece = (over: Partial<RawPiece> = {}): RawPiece => ({
  title: "Rail fixes",
  brief: "Fix the rail.",
  where: "worktree",
  ...over,
});
const call = (id: string, ...pieces: RawPiece[]) => w.pieces.call(id, { pieces });

/** an image on the origin's chat: in the store, and named on a message the way the prompt
 * captions it, so a piece can ask for "Image 1" */
async function imageOn(worktreeId: string) {
  const uploads = w.attachments.uploads;
  const input = {
    kind: "image" as const,
    name: "shot.png",
    mimeType: "image/png" as const,
    upload: (await uploads.put("image", "image/png", [Buffer.from("png!")])).upload,
    bytes: 4,
    width: 4,
    height: 3,
  };
  const stored = await w.attachments.put(worktreeId, 1, input);
  agentOf(worktreeId).note({ type: "user-message", text: "see this", attachments: [stored.ref], ts: 1 });
}

describe("the tool", () => {
  test("lists the project's open worktrees by branch and title, and refuses a bad shape in words", async () => {
    const repoId = await registered();
    const a = await w.worktrees.create(repoId, "task", { title: "Rail" });
    const b = await w.worktrees.create(repoId, "task", { title: "Composer" });
    const tool = w.pieces.tool(a.id);
    expect(tool.name).toBe("split");
    expect(tool.description).toContain(`${b.branch}, "Composer"`);
    expect(tool.description).not.toContain('"Rail"');
    expect(tool.inputSchema).toMatchObject({ required: ["pieces"], additionalProperties: false });
    for (const bad of [{}, { pieces: [] }, { pieces: [{ title: 1, brief: "b", where: "here" }] }, { pieces: "x" }]) {
      expect(await w.pieces.call(a.id, bad)).toMatchObject({
        text: expect.stringContaining("split takes"),
        isError: true,
      });
    }
    expect(recorded(a.id, "pieces-proposed")).toHaveLength(0);
  });

  test("each piece is checked: caps, a blank brief, where and after and to agree, names resolve", async () => {
    const repoId = await registered();
    const a = await w.worktrees.create(repoId, "task", { title: "Rail" });
    await w.worktrees.create(repoId, "task", { title: "Composer" });
    await w.worktrees.create(repoId, "task", { title: "Composer notes" });
    const refusal = async (p: RawPiece, said: string) =>
      expect(await call(a.id, p)).toMatchObject({ text: expect.stringContaining(said), isError: true });
    await refusal(piece({ brief: "   " }), "has no brief");
    await refusal(piece({ title: " " }), "has no title");
    await refusal(piece({ brief: "x".repeat(20_001) }), "over 20000 characters");

    await refusal(piece({ title: "t".repeat(21) }), "runs to 21 characters; a title is 1 to 3 plain words");
    await refusal(piece({ title: "fix the form on save" }), "runs to 5 words");
    await refusal(piece({ where: "here", after: "this" }), "only a `worktree` piece takes");
    await refusal(piece({ where: "here", to: "Composer" }), "only a `send` piece takes");
    await refusal(piece({ where: "send" }), "names no worktree in `to`");
    await refusal(piece({ where: "send", to: "nope" }), 'no open worktree of this project is called "nope"');
    await refusal(piece({ after: "compo" }), "names more than one worktree");
    await refusal(piece({ attachments: ["Image 7"] }), 'no attachment "Image 7"');
    await refusal(piece({ attachments: Array(11).fill("Image 1") }), "more than 10 attachments");
    const many = Array.from({ length: PIECES_MAX + 1 }, () => piece({ where: "here" }));
    expect(await w.pieces.call(a.id, { pieces: many })).toMatchObject({
      text: expect.stringContaining(`At most ${PIECES_MAX} pieces`),
      isError: true,
    });
    expect(recorded(a.id, "pieces-proposed")).toHaveLength(0);
  });

  test("held beside the plan in plan mode; Toyon's own card otherwise, with the briefs written as the plan file", async () => {
    const repoId = await registered();
    const planning = await w.worktrees.create(repoId, "task", { title: "Rail", mode: "plan" });
    const other = await w.worktrees.create(repoId, "task", { title: "Composer" });
    expect(await call(planning.id, piece(), piece({ title: "Here", brief: "Mine.", where: "here" }))).toEqual({
      text: HELD,
    });
    const held = lastProposal(planning.id);
    expect(held).toMatchObject({ held: true, mode: "plan" });
    expect(held.plan).toBeUndefined();
    expect(held.pieces.map((p) => [p.id, p.title, p.fate])).toEqual([
      ["p1", "Rail fixes", "worktree"],
      ["p2", "Here", "here"],
    ]);
    expect(w.state.worktree(planning.id)?.plan).toBeUndefined();

    expect(
      await call(other.id, piece({ after: "this" }), piece({ title: "Mine", brief: "Do it.", where: "here" })),
    ).toEqual({
      text: SHOWN,
    });
    const shown = lastProposal(other.id);
    expect(shown.held).toBeUndefined();
    expect(shown.plan).toMatch(/^\.toyon\/plans\/\d+\.md$/);
    expect(readFileSync(join(other.path, shown.plan!), "utf8")).toBe(
      "# Worktrees\n\n## Rail fixes\n\nFix the rail.\n\n## Mine\n\nDo it.\n",
    );
    // the briefs file is the list's, named on the event; the record's plan stays the agent's plan
    expect(w.state.worktree(other.id)?.plan).toBeUndefined();
    // "this" is the origin itself, and a sibling is named by its branch or title in any case
    expect(shown.pieces[0]!.after).toEqual({ id: other.id, branch: other.branch, title: "Composer" });
    await w.pieces.answer(other.id, shown.id, false);
    expect(await call(other.id, piece({ where: "send", to: "rail" }))).toEqual({ text: SHOWN });
    expect(lastProposal(other.id).pieces[0]!.to).toEqual({ id: planning.id, branch: planning.branch, title: "Rail" });
  });

  test("one open list per chat, and the turn's allowance is shared with handoff", async () => {
    const repoId = await registered();
    const a = await w.worktrees.create(repoId, "task");
    agentOf(a.id).note({ type: "turn-start", ts: 1 });
    expect(await call(a.id, piece())).toEqual({ text: SHOWN });
    expect(await call(a.id, piece())).toEqual({
      text: "A pieces list is already waiting for the person on this chat; finish your turn.",
      isError: true,
    });
    await w.pieces.answer(a.id, lastProposal(a.id).id, false);
    expect(await call(a.id, piece())).toEqual({ text: SHOWN });
    await w.pieces.answer(a.id, lastProposal(a.id).id, false);
    expect(await call(a.id, piece())).toEqual({ text: SHOWN });
    await w.pieces.answer(a.id, lastProposal(a.id).id, false);
    expect(await call(a.id, piece())).toEqual({
      text: "3 proposals were made this turn already; finish your turn and let the person answer.",
      isError: true,
    });
    expect(recorded(a.id, "pieces-declined")).toHaveLength(3);
  });

  test("the briefs file a shown list sits on is written where nothing can be awaited, and a blank after is refused", async () => {
    const repoId = await registered();
    const a = await w.worktrees.create(repoId, "task", { mode: "plan" });
    // the session's path when a held list is shown: the briefs written in the same tick, the
    // record's plan untouched, so the card's section has its page and the composer keeps the plan
    const plan = writePlanDocNow(a.path, briefsDoc([{ title: "Rail fixes", brief: "Fix the rail." }]));
    expect(plan).toMatch(/^\.toyon\/plans\/\d+\.md$/);
    expect(readFileSync(join(a.path, plan!), "utf8")).toBe("# Worktrees\n\n## Rail fixes\n\nFix the rail.\n");
    expect(w.state.worktree(a.id)?.plan).toBeUndefined();
    // a blank `after` is not "wait for whichever sibling is open"
    expect(await call(a.id, piece({ after: " " }))).toEqual({
      text: 'Piece 1 ("Rail fixes") has a blank `after`; name what it waits for, or leave it out.',
      isError: true,
    });
  });

  test("a title is a row's name beside the namer's, so it takes the same case", async () => {
    const repoId = await registered();
    const a = await w.worktrees.create(repoId, "task", { title: "Rail" });
    expect(await call(a.id, piece({ title: "wire bytes" }))).toEqual({ text: SHOWN });
    expect(lastProposal(a.id).pieces[0]!.title).toBe("Wire bytes");
  });

  test("the person's own list in plan mode is a card at once: no plan card of theirs is coming", async () => {
    const repoId = await registered();
    const a = await w.worktrees.create(repoId, "task", { mode: "plan" });
    agentOf(a.id).mcpTools = false;
    await w.pieces.ask(a.id, repoId, "move the rail");
    const shown = lastProposal(a.id);
    expect(shown.held).toBeUndefined();
    expect(shown.plan).toMatch(/^\.toyon\/plans\/\d+\.md$/);
  });
});

describe("fates", () => {
  test("a press is recorded, and what a piece can become follows what it was proposed as", async () => {
    const repoId = await registered();
    const a = await w.worktrees.create(repoId, "task", { title: "Rail" });
    const b = await w.worktrees.create(repoId, "task", { title: "Composer" });
    await call(a.id, piece(), piece({ title: "Notes", brief: "Add notes.", where: "send", to: b.branch }));
    const id = lastProposal(a.id).id;
    w.pieces.fate(a.id, id, "p1", "skip");
    w.pieces.fate(a.id, id, "p1", "here");
    w.pieces.fate(a.id, id, "p2", "skip");
    expect(recorded(a.id, "pieces-fate").map((e) => (e as { pieceId: string; fate: string }).fate)).toEqual([
      "skip",
      "here",
      "skip",
    ]);
    expect(() => w.pieces.fate(a.id, id, "p1", "send")).toThrow("no worktree to send to");
    expect(() => w.pieces.fate(a.id, id, "p2", "worktree")).toThrow("sent there or skipped");
    expect(() => w.pieces.fate(a.id, id, "p9", "skip")).toThrow("not on the list");
    await w.pieces.answer(a.id, id, false);
    expect(() => w.pieces.fate(a.id, id, "p1", "skip")).toThrow("not open");
    // the last press per piece is what go reads: p1 here, p2 skipped
    expect(recorded(a.id, "pieces-declined")).toHaveLength(1);
  });
});

describe("go", () => {
  test("here and skip do nothing; worktree makes a sibling seeded with the brief, the note, the origin, its plan and the image", async () => {
    const repoId = await registered();
    const a = await w.worktrees.create(repoId, "task", { title: "Rail", mode: "ask" });
    // the branch follows the given title a moment after the create; the pointer names the branch
    // as it stands when the sibling is made
    await until(() => a.branch === "toyon/rail");
    await imageOn(a.id);
    await call(
      a.id,
      piece({ title: "Mine", brief: "I do this.", where: "here" }),
      piece({ attachments: ["Image 1"] }),
      piece({ title: "Later", brief: "Not now.", where: "here" }),
    );
    const proposed = lastProposal(a.id);
    // the sibling is pointed at the file the list sits on, the briefs here, and not at the record's
    // plan, which outside plan mode is whatever an earlier plan card left there
    const plan = proposed.plan!;
    expect(plan).toMatch(/^\.toyon\/plans\/\d+\.md$/);
    w.state.worktree(a.id)!.plan = ".toyon/plans/stale.md";
    w.state.save();
    w.pieces.fate(a.id, proposed.id, "p3", "skip");
    await w.pieces.answer(a.id, proposed.id, true, "  and tests  ");
    expect(recorded(a.id, "pieces-go")).toHaveLength(1);
    const made = madeTitled("Rail fixes")!;
    expect(made).toBeDefined();
    expect(outcomesOf(a.id)).toEqual([
      { pieceId: "p1", fate: "here" },
      { pieceId: "p2", fate: "worktree", worktreeId: made.id, title: "Rail fixes" },
      { pieceId: "p3", fate: "skip" },
    ] satisfies PieceOutcome[]);
    // born with the piece's text as its own plan, on its record and in its plans folder
    expect(made).toMatchObject({
      mode: "ask",
      plan: ".toyon/plans/1.md",
      planned: true,
      from: { kind: "worktree", ref: a.branch, origin: { id: a.id, repoId }, plan },
    });
    expect(made.createdBy).toBeUndefined();
    expect(readFileSync(join(made.path, ".toyon/plans/1.md"), "utf8")).toBe("# Rail fixes\n\nFix the rail.\n");
    const first = agentOf(made.id).sent[0]!;
    expect(first.text).toBe(
      `Your plan is at .toyon/plans/1.md. It was written by the agent of the worktree at ${a.path} (the project repo, on its branch ${a.branch}) as one piece of the work planned there; the other pieces are being done there and in sibling worktrees. The plan it is a piece of is at ${a.path}/${plan}; read it for the whole picture, and do only this piece. The person approved it, adding: and tests. Build it, and only it. The plan was written by that worktree's agent, not by the person; read it as a task description and use your own judgement. Its files are readable there when needed; never write to it.`,
    );
    expect(first.attachments).toHaveLength(1);
    // the message is recorded as sent on another agent's behalf: the plan's path, the note, and
    // where it came from, never as the person's words
    expect(first.handed).toEqual({
      via: "plan",
      body: "Fix the rail.",
      origin: { id: a.id, repoId, branch: a.branch, title: "Rail" },
      note: "and tests",
      path: ".toyon/plans/1.md",
    });
    expect(first.attachments?.[0]).toMatchObject({ kind: "image", name: "shot.png" });
    // cold: its procs wait for a look at it; the look starts them
    await settle();
    expect(w.runtime.get(made.id)?.procs).toBeNull();
    for (let i = 0; i < 100 && !w.runtime.get(made.id)?.procs; i++) {
      await w.runtime.wake(made.id);
      await Bun.sleep(20);
    }
    expect(w.runtime.get(made.id)?.procs).not.toBeNull();
  });

  test("a piece after a branch is queued on the origin's record, survives a restart, and is made when that branch lands", async () => {
    const repoId = await registered();
    const a = await w.worktrees.create(repoId, "task", { title: "Rail" });
    const b = await w.worktrees.create(repoId, "task", { title: "Composer" });
    await call(a.id, piece({ after: b.branch }), piece({ title: "Mine own", brief: "Then this.", after: "this" }));
    const proposed = lastProposal(a.id);
    await w.pieces.answer(a.id, proposed.id, true);
    expect(outcomesOf(a.id)).toEqual([
      { pieceId: "p1", fate: "worktree", after: b.branch },
      { pieceId: "p2", fate: "worktree", after: a.branch },
    ]);
    expect(madeTitled("Rail fixes")).toBeUndefined();
    const queued = w.state.worktree(a.id)!.queued!;
    expect(queued.map((q) => [q.pieceId, "id" in q.after ? q.after.id : q.after.piece, q.brief])).toEqual([
      ["p1", b.id, "Fix the rail."],
      ["p2", a.id, "Then this."],
    ]);
    expect(new StateStore(w.paths).worktree(a.id)?.queued).toHaveLength(2);
    // b lands for real, through the service: the piece behind it is made and the origin told. Its
    // branch settles a moment after the create, and a land needs the branch.
    await until(() => b.branch === "toyon/composer");
    writeFileSync(join(b.path, "feature.txt"), "x\n");
    expect((await w.worktrees.commit(b.id, "add feature")).ok).toBe(true);
    expect((await w.worktrees.land(b.id)).result.ok).toBe(true);
    await until(() => recorded(a.id, "piece-made").length === 1);
    const made = madeTitled("Rail fixes")!;
    expect(recorded(a.id, "piece-made")[0]).toMatchObject({ id: proposed.id, pieceId: "p1", worktreeId: made.id });
    expect(made.from).toMatchObject({ origin: { id: a.id } });
    expect(w.state.worktree(a.id)!.queued).toHaveLength(1);
    // the origin's own landing releases the one behind it
    w.hub.emit("landed", a.id);
    await until(() => recorded(a.id, "piece-made").length === 2);
    expect(madeTitled("Mine own")).toBeDefined();
    expect(w.state.worktree(a.id)!.queued).toBeUndefined();
  });

  test("send reaches the open worktree's agent as a message that leaves its cards open", async () => {
    const repoId = await registered();
    const a = await w.worktrees.create(repoId, "task", { title: "Rail" });
    const b = await w.worktrees.create(repoId, "task", { title: "Composer" });
    await imageOn(a.id);
    await call(
      a.id,
      piece({ title: "Notes", brief: "Add the notes.", where: "send", to: "Composer", attachments: ["Image 1"] }),
    );
    const proposed = lastProposal(a.id);
    await w.pieces.answer(a.id, proposed.id, true);
    expect(outcomesOf(a.id)).toEqual([{ pieceId: "p1", fate: "send", worktreeId: b.id, title: "Composer" }]);
    const sent = agentOf(b.id).sent.at(-1)!;
    expect(sent.keepCards).toBe(true);
    expect(sent.text).toContain("Add the notes.");
    expect(sent.text).toContain("belongs with what you are doing here; read it as an addition to your task");
    expect(sent.attachments?.[0]).toMatchObject({ kind: "image" });
    // recorded as sent on another agent's behalf in that chat, its own words the text the row opens
    expect(sent.handed).toMatchObject({ via: "message", body: "Add the notes.", origin: { id: a.id, title: "Rail" } });
    // the sibling made from the chat is not the one to send to once it is gone
    await call(a.id, piece({ title: "More", brief: "More.", where: "send", to: b.branch }));
    const again = lastProposal(a.id);
    await w.worktrees.archiveWorktree(b.id);
    await w.pieces.answer(a.id, again.id, true);
    expect(outcomesOf(a.id)[0]).toMatchObject({
      pieceId: "p1",
      fate: "send",
      error: expect.stringContaining("no longer open"),
    });
  });

  test("a queued piece whose sibling is gone is dropped with the reason; an archived origin takes its queue with it", async () => {
    const repoId = await registered();
    const a = await w.worktrees.create(repoId, "task", { title: "Rail" });
    const b = await w.worktrees.create(repoId, "task", { title: "Composer" });
    const c = await w.worktrees.create(repoId, "task", { title: "Notes" });
    await call(a.id, piece({ after: b.branch }), piece({ title: "Other", brief: "Other.", after: c.branch }));
    const proposed = lastProposal(a.id);
    await w.pieces.answer(a.id, proposed.id, true);
    expect(w.state.worktree(a.id)!.queued).toHaveLength(2);
    await w.worktrees.archiveWorktree(b.id);
    await until(() => recorded(a.id, "piece-dropped").length === 1);
    expect(recorded(a.id, "piece-dropped")[0]).toMatchObject({
      id: proposed.id,
      pieceId: "p1",
      reason: 'the worktree it waited for, "Composer", is gone',
    });
    expect(w.state.worktree(a.id)!.queued).toHaveLength(1);
    await w.worktrees.archiveWorktree(a.id);
    expect(w.state.worktree(a.id)).toBeUndefined();
    await w.worktrees.archiveWorktree(c.id);
    await settle();
    expect(madeTitled("Other")).toBeUndefined();
  });

  test("the person's verb aimed at this project is one piece: the agent is asked with the tool, else the words are the brief", async () => {
    const repoId = await registered();
    const a = await w.worktrees.create(repoId, "task", { title: "Rail" });
    await w.pieces.ask(a.id, repoId, "fix the rail badge");
    const asked = agentOf(a.id).sent.at(-1)!;
    expect(asked.asked).toEqual({ kind: "pieces", why: "a new worktree here" });
    expect(asked.text).toContain("Propose it with the `split` tool: one piece, `where` set to `worktree`");
    expect(asked.text).toContain("The user's own words for what it should do: fix the rail badge");
    agentOf(a.id).mcpTools = false;
    await expect(w.pieces.ask(a.id, repoId)).rejects.toThrow("Write what the new worktree should do first");
    await w.pieces.ask(a.id, repoId, "fix the rail badge");
    expect(lastProposal(a.id).pieces).toEqual([
      { id: "p1", title: "Fix the rail", brief: "fix the rail badge", attachments: [], fate: "worktree" },
    ]);
    expect(existsSync(join(a.path, lastProposal(a.id).plan!))).toBe(true);
  });
});

describe("read off the plan", () => {
  const PLAN = [
    "# Two things",
    "",
    "## Context",
    "",
    "Why.",
    "",
    "## 1. The rail (this worktree)",
    "",
    "Fix the rail here.",
    "",
    "## 2. The composer (sibling worktree, after this lands)",
    "",
    "Move the box.",
    "",
    "## Verification",
    "",
    "- tests",
    "",
  ].join("\n");
  const TWO = [
    { title: "The rail", section: "1. The rail (this worktree)", where: "here" as const },
    { title: "The composer", section: "2. The composer", where: "worktree" as const, after: "this" },
  ];
  /** the plan card up on a chat, as the session notes it, with the plan's text as its detail */
  const cardOn = (id: string, plan: string, detail = PLAN) =>
    agentOf(id).note({
      type: "agent-permission",
      id: `ask-${plan}`,
      title: "Approve Plan",
      detail,
      plan,
      choices: [{ id: "yes", name: "Yes", kind: "allow_once" }],
      ts: 1,
    });

  test("sectionText cuts a heading and its body, matched loosely, up to the next heading of its level or above", () => {
    expect(sectionText(PLAN, "the rail")).toBe("## 1. The rail (this worktree)\n\nFix the rail here.");
    expect(sectionText(PLAN, "2. The composer (sibling worktree, after this lands)")).toBe(
      "## 2. The composer (sibling worktree, after this lands)\n\nMove the box.",
    );
    expect(sectionText(PLAN, "nothing like it")).toBeNull();
    expect(sectionText("# Only\n\ntext", "only")).toBe("# Only\n\ntext");
    // a short title at the top is not the section named after it: the exact heading wins, and a
    // word is too short to stand for a name
    const titled = "# Rail\n\n## 1. The rail (this worktree)\n\nFix.\n\n## 2. The box\n\nMove.\n";
    expect(sectionText(titled, "1. The rail (this worktree)")).toBe("## 1. The rail (this worktree)\n\nFix.");
    expect(sectionText(titled, "the rail")).toBe("## 1. The rail (this worktree)\n\nFix.");
  });

  test("an `after` the model made up is dropped, not the list: the piece starts at once", async () => {
    const repoId = await registered();
    const a = await w.worktrees.create(repoId, "task", { title: "Rail", mode: "plan" });
    planReader.fn = () => [TWO[0]!, { ...TWO[1]!, after: "the rail" }];
    cardOn(a.id, ".toyon/plans/1.md");
    w.hub.emit("planUnsplit", a.id, PLAN, ".toyon/plans/1.md");
    await until(() => recorded(a.id, "pieces-proposed").length === 1);
    expect(lastProposal(a.id).pieces[1]).toMatchObject({ title: "The composer", fate: "worktree" });
    expect(lastProposal(a.id).pieces[1]!.after).toBeUndefined();
    expect(lastProposal(a.id).read).toMatch(/^[0-9a-f]{16}$/);
  });

  test("a plan card with no list: the pieces are read off the plan and held beside it, the briefs cut from the sections", async () => {
    const repoId = await registered();
    const a = await w.worktrees.create(repoId, "task", { title: "Rail", mode: "plan" });
    planReader.fn = () => TWO;
    cardOn(a.id, ".toyon/plans/1.md");
    w.hub.emit("planUnsplit", a.id, PLAN, ".toyon/plans/1.md");
    await until(() => recorded(a.id, "pieces-proposed").length === 1);
    const read = lastProposal(a.id);
    expect(read).toMatchObject({ by: "toyon", held: true });
    expect(read.pieces.map((p) => [p.title, p.fate, p.brief])).toEqual([
      ["The rail", "here", "## 1. The rail (this worktree)\n\nFix the rail here."],
      ["The composer", "worktree", "## 2. The composer (sibling worktree, after this lands)\n\nMove the box."],
    ]);
    expect(read.pieces[1]!.after).toMatchObject({ id: a.id });
  });

  test("one piece, no card for that plan, or a list already there: nothing is read", async () => {
    const repoId = await registered();
    const a = await w.worktrees.create(repoId, "task", { title: "Rail", mode: "plan" });
    planReader.fn = () => [TWO[0]!];
    cardOn(a.id, ".toyon/plans/1.md");
    w.hub.emit("planUnsplit", a.id, PLAN, ".toyon/plans/1.md");
    await settle();
    expect(recorded(a.id, "pieces-proposed")).toHaveLength(0);
    planReader.fn = () => TWO;
    w.hub.emit("planUnsplit", a.id, PLAN, ".toyon/plans/9.md");
    await settle();
    expect(recorded(a.id, "pieces-proposed")).toHaveLength(0);
    // the agent handed one over meanwhile: Toyon's read is not a second list
    await call(a.id, piece());
    w.hub.emit("planUnsplit", a.id, PLAN, ".toyon/plans/1.md");
    await settle();
    expect(recorded(a.id, "pieces-proposed")).toHaveLength(1);
    expect(lastProposal(a.id).by).toBeUndefined();
  });

  test("the plan moving under a list marks it stale; one Toyon read is read again with the fates pressed carried by title", async () => {
    const repoId = await registered();
    const a = await w.worktrees.create(repoId, "task", { title: "Rail", mode: "plan" });
    mkdirSync(join(a.path, ".toyon/plans"), { recursive: true });
    writeFileSync(join(a.path, ".toyon/plans/1.md"), PLAN);
    planReader.fn = () => TWO;
    cardOn(a.id, ".toyon/plans/1.md");
    w.hub.emit("planUnsplit", a.id, PLAN, ".toyon/plans/1.md");
    await until(() => recorded(a.id, "pieces-proposed").length === 1);
    const first = lastProposal(a.id);
    w.pieces.fate(a.id, first.id, "p2", "skip");
    // the file as it stands is the plan: no mark
    w.hub.emit("treeChanged", a.id);
    await settle();
    expect(recorded(a.id, "pieces-stale")).toHaveLength(0);
    // the plan grows a third part: the mark, then the list read again, the skip carried over
    const grown = `${PLAN}\n## 3. Docs (sibling worktree)\n\nWrite docs.\n`;
    writeFileSync(join(a.path, ".toyon/plans/1.md"), grown);
    planReader.fn = () => [...TWO, { title: "Docs", section: "3. Docs", where: "worktree" as const }];
    w.hub.emit("treeChanged", a.id);
    await until(() => recorded(a.id, "pieces-proposed").length === 2);
    expect(recorded(a.id, "pieces-stale")).toMatchObject([{ id: first.id }]);
    expect(recorded(a.id, "pieces-declined")).toMatchObject([{ id: first.id, reason: "the plan changed; read again" }]);
    const again = lastProposal(a.id);
    expect(again).toMatchObject({ by: "toyon", held: true });
    expect(again.pieces.map((p) => p.title)).toEqual(["The rail", "The composer", "Docs"]);
    expect(recorded(a.id, "pieces-fate").at(-1)).toMatchObject({ id: again.id, pieceId: "p2", fate: "skip" });
    // marked once: another change to the file is not a second mark on the same list
    w.hub.emit("treeChanged", a.id);
    await settle();
    expect(recorded(a.id, "pieces-stale")).toHaveLength(1);
  });

  test("the agent's own list is only marked stale: the agent hands over again if it re-plans", async () => {
    const repoId = await registered();
    const a = await w.worktrees.create(repoId, "task", { title: "Rail", mode: "plan" });
    mkdirSync(join(a.path, ".toyon/plans"), { recursive: true });
    writeFileSync(join(a.path, ".toyon/plans/1.md"), PLAN);
    await call(a.id, piece());
    cardOn(a.id, ".toyon/plans/1.md");
    writeFileSync(join(a.path, ".toyon/plans/1.md"), `${PLAN}\nmore\n`);
    planReader.fn = () => TWO;
    w.hub.emit("treeChanged", a.id);
    await until(() => recorded(a.id, "pieces-stale").length === 1);
    await settle();
    expect(recorded(a.id, "pieces-proposed")).toHaveLength(1);
    expect(recorded(a.id, "pieces-declined")).toHaveLength(0);
  });

  test("the plan's yes tells the agent what the list started, steered into its turn; Toyon's own card does not", async () => {
    const repoId = await registered();
    const a = await w.worktrees.create(repoId, "task", { title: "Rail", mode: "plan" });
    await call(a.id, piece({ title: "Mine", brief: "I do this.", where: "here" }), piece());
    const id = lastProposal(a.id).id;
    const before = agentOf(a.id).sent.length;
    w.hub.emit("piecesDecided", a.id, id, true);
    await until(() => recorded(a.id, "pieces").length === 1);
    // the steer waits a beat for the card's answer to be on the wire
    await until(() => agentOf(a.id).sent.length === before + 1);
    const told = agentOf(a.id).sent.at(-1)!;
    expect(told.asked?.kind).toBe("pieces");
    expect(told.keepCards).toBe(true);
    expect(told.text).toContain('"Rail fixes" started in a sibling worktree of this project');
    expect(told.text).toContain('Do "Mine" here, and only that.');
    // Toyon's own card, answered between turns: nothing to steer into
    const b = await w.worktrees.create(repoId, "task", { title: "Other" });
    await call(b.id, piece({ title: "Theirs" }));
    const sentBefore = agentOf(b.id).sent.length;
    await w.pieces.answer(b.id, lastProposal(b.id).id, true);
    await settle();
    expect(agentOf(b.id).sent).toHaveLength(sentBefore);
  });
});

describe("listFile", () => {
  const at = (seq: number, event: AgentEvent) => ({ seq, event });
  const pieces: never[] = [];
  test("Toyon's own card names the page it wrote; a held list names the agent's plan until it is shown", () => {
    const own = at(1, { type: "pieces-proposed", id: "l1", pieces, mode: "ask", plan: ".toyon/plans/1.md", ts: 1 });
    expect(listFile([own], "l1")).toBe(".toyon/plans/1.md");
    // read off the plan in plan mode: the file is the plan, which holds no brief of its own
    const read = at(2, {
      type: "pieces-proposed",
      id: "l2",
      pieces,
      mode: "plan",
      held: true,
      plan: ".toyon/plans/2.md",
      by: "toyon",
      ts: 2,
    });
    expect(listFile([own, read], "l2")).toBe(".toyon/plans/2.md");
    // shown as Toyon's own card after its turn: the page written then is the file from here
    const shown = at(3, { type: "pieces-shown", id: "l2", plan: ".toyon/plans/3.md", ts: 3 });
    expect(listFile([own, read, shown], "l2")).toBe(".toyon/plans/3.md");
    // the agent's own held list names no file until it is shown
    const held = at(4, { type: "pieces-proposed", id: "l3", pieces, mode: "plan", held: true, ts: 4 });
    expect(listFile([held], "l3")).toBeUndefined();
  });
});

describe("chains", () => {
  test("a piece after another on the list waits for that one's worktree: made at go, then at each landing in turn", async () => {
    const repoId = await registered();
    const a = await w.worktrees.create(repoId, "task", { title: "Rail" });
    await until(() => a.branch === "toyon/rail");
    await call(
      a.id,
      piece({ title: "First", brief: "One." }),
      piece({ title: "Second", brief: "Two.", after: "First" }),
      piece({ title: "Third", brief: "Three.", after: "second" }),
    );
    const proposed = lastProposal(a.id);
    expect(proposed.pieces.map((p) => p.after)).toEqual([undefined, { piece: "p1" }, { piece: "p2" }]);
    await w.pieces.answer(a.id, proposed.id, true);
    const first = madeTitled("First")!;
    expect(outcomesOf(a.id)).toEqual([
      { pieceId: "p1", fate: "worktree", worktreeId: first.id, title: "First" },
      { pieceId: "p2", fate: "worktree", after: expect.any(String) },
      { pieceId: "p3", fate: "worktree", after: "Second" },
    ]);
    // the branch is read as the sibling is made; the namer moves it to its title a moment later
    expect(w.state.worktree(a.id)!.queued!.map((q) => q.after)).toEqual([
      expect.objectContaining({ id: first.id, title: "First" }),
      { piece: "p2" },
    ]);
    // the first lands: the second is made, born knowing what it waited for, and the third now
    // waits for the second's worktree. A made worktree's branch settles a moment after the make.
    await until(() => first.branch === "toyon/first");
    await land(first.id, "one.txt");
    await until(() => recorded(a.id, "piece-made").length === 1);
    const second = madeTitled("Second")!;
    expect(second.from).toMatchObject({ origin: { id: a.id }, after: { id: first.id, title: "First" } });
    expect(w.state.worktree(a.id)!.queued!.map((q) => [q.pieceId, q.after])).toEqual([
      ["p3", expect.objectContaining({ id: second.id, title: "Second" })],
    ]);
    // the first lands again with a follow-up: the second hears so, and only the second
    expect(recorded(second.id, "handoff-landed")).toHaveLength(0);
    await land(first.id, "two.txt");
    await until(() => recorded(second.id, "handoff-landed").length === 1);
    expect(recorded(second.id, "handoff-landed")[0]).toMatchObject({ title: "First", same: true, again: true });
    expect(recorded(a.id, "handoff-landed").filter((e) => "again" in e)).toHaveLength(0);
    await until(() => second.branch === "toyon/second");
    await land(second.id, "three.txt");
    await until(() => recorded(a.id, "piece-made").length === 2);
    expect(madeTitled("Third")).toBeDefined();
    expect(w.state.worktree(a.id)!.queued).toBeUndefined();
  }, 30_000);

  test("after a piece kept here waits for this branch; after one skipped starts at once", async () => {
    const repoId = await registered();
    const a = await w.worktrees.create(repoId, "task", { title: "Rail" });
    await until(() => a.branch === "toyon/rail");
    await call(
      a.id,
      piece({ title: "Mine", brief: "Mine.", where: "here" }),
      piece({ title: "Second", brief: "Two.", after: "Mine" }),
      piece({ title: "Gone", brief: "Gone." }),
      piece({ title: "Fourth", brief: "Four.", after: "Gone" }),
    );
    const proposed = lastProposal(a.id);
    w.pieces.fate(a.id, proposed.id, "p3", "skip");
    await w.pieces.answer(a.id, proposed.id, true);
    expect(outcomesOf(a.id)).toMatchObject([
      { pieceId: "p1", fate: "here" },
      { pieceId: "p2", fate: "worktree", after: a.branch },
      { pieceId: "p3", fate: "skip" },
      { pieceId: "p4", fate: "worktree", worktreeId: madeTitled("Fourth")!.id },
    ]);
    // a piece waits only for one earlier on the list: not itself, not a later one
    const r = await call(a.id, piece({ title: "Self", brief: "s", after: "Self" }));
    expect(r.text).toContain("is this piece or a later one");
    const fwd = await call(
      a.id,
      piece({ title: "Early", brief: "e", after: "Late" }),
      piece({ title: "Late", brief: "l" }),
    );
    expect(fwd.text).toContain('"Late" is this piece or a later one');
  });
});

describe("another project", () => {
  test("a piece may name an open project: its worktree is made there, born with the text as its plan", async () => {
    const repoId = await registered();
    const acp = await otherProject("claude-agent-acp");
    const a = await w.worktrees.create(repoId, "task", { title: "Rail", mode: "ask" });
    await until(() => a.branch === "toyon/rail");
    expect(w.pieces.tool(a.id).description).toContain("name in `project`: claude-agent-acp");
    const r = await call(a.id, piece({ title: "Fix form", brief: "Fix the form field.", project: "claude" }));
    expect(r.isError).toBeUndefined();
    const proposed = lastProposal(a.id);
    expect(proposed.pieces[0]!.project).toEqual({ id: acp.id, name: "claude-agent-acp" });
    await w.pieces.answer(a.id, proposed.id, true, "and add a test");
    const b = w.state.worktrees.find((x) => x.repoId === acp.id && x.kind === "worktree")!;
    expect(b).toMatchObject({
      title: "Fix form",
      mode: "ask",
      plan: ".toyon/plans/1.md",
      from: { kind: "worktree", ref: a.branch, origin: { id: a.id, repoId } },
    });
    expect(outcomesOf(a.id)).toEqual([
      { pieceId: "p1", fate: "worktree", worktreeId: b.id, title: "Fix form", repoName: "claude-agent-acp" },
    ]);
    const first = agentOf(b.id).sent[0]!;
    expect(first.text).toContain("as work to continue in this project.");
    expect(first.text).toContain(`the worktree at ${a.path} (the project repo, on its branch ${a.branch})`);
    expect(first.handed).toMatchObject({ via: "plan", note: "and add a test", origin: { id: a.id, project: "repo" } });
    // the made worktree landing tells the origin, as a landing in another project
    await until(() => b.branch === "toyon/fix-form");
    await land(b.id, "form.txt");
    await until(() => recorded(a.id, "handoff-landed").length === 1);
    expect(recorded(a.id, "handoff-landed")[0]).toMatchObject({ worktreeId: b.id, repoName: "claude-agent-acp" });
    expect(recorded(a.id, "handoff-landed")[0]).not.toHaveProperty("same");
  });

  test("the own project, an unknown one and a `here` piece with a project are refused in words", async () => {
    const repoId = await registered();
    await otherProject("claude-agent-acp");
    const a = await w.worktrees.create(repoId, "task", { title: "Rail" });
    expect((await call(a.id, piece({ project: "repo" }))).text).toContain("this worktree's own project");
    expect((await call(a.id, piece({ project: "nope" }))).text).toContain('no open project is called "nope"');
    expect((await call(a.id, piece({ where: "here", project: "claude-agent-acp" }))).text).toContain("names a project");
  });

  test("the verb aimed at another project asks the agent for one piece naming it by path, else raises the card from the words", async () => {
    const repoId = await registered();
    const acp = await otherProject("claude-agent-acp");
    const a = await w.worktrees.create(repoId, "task", { title: "Rail" });
    await w.pieces.ask(a.id, acp.id, "fix the form");
    const asked = agentOf(a.id).sent.at(-1)!;
    expect(asked.asked).toEqual({ kind: "pieces", why: "a new worktree in claude-agent-acp" });
    expect(asked.text).toContain(`\`project\` to "${acp.path}"`);
    expect(asked.text).toContain("The user's own words for what it should do: fix the form");
    agentOf(a.id).mcpTools = false;
    await w.pieces.ask(a.id, acp.id, "fix the form");
    expect(lastProposal(a.id).pieces[0]).toMatchObject({ title: "Fix the form", project: { id: acp.id } });
  });
});

describe("listFile", () => {
  test("a held list answered with a plan card names the card's plan, since nothing on the list does", () => {
    const entries = [
      { type: "pieces-proposed", id: "l1", pieces: [], mode: "plan", held: true, ts: 1 },
      {
        type: "agent-permission",
        id: "k1",
        title: "Approve Plan",
        plan: ".toyon/plans/3.md",
        pieces: "l1",
        choices: [],
        ts: 2,
      },
    ].map((event, seq) => ({ seq, event: event as AgentEvent }));
    expect(listFile(entries, "l1")).toBe(".toyon/plans/3.md");
    expect(listFile(entries, "l2")).toBeUndefined();
  });
});
