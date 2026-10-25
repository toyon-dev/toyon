import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, PieceOutcome } from "@toyon/shared";
import type { FakeAgent } from "../../test/helpers/fakes.ts";
import { registered, settle, until, useWorld, w } from "../../test/helpers/world.ts";
import { briefsDoc, writePlanDocNow } from "../agent/planDoc.ts";
import { StateStore } from "../core/state.ts";
import { PIECES_MAX, type RawPiece } from "./pieces.ts";

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
    await refusal(piece({ brief: "x".repeat(6_001) }), "over 6000 characters");
    await refusal(piece({ title: "t".repeat(201) }), "over 200 characters");
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
      "## Rail fixes\n\nFix the rail.\n\n## Mine\n\nDo it.\n",
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
    expect(readFileSync(join(a.path, plan!), "utf8")).toBe("## Rail fixes\n\nFix the rail.\n");
    expect(w.state.worktree(a.id)?.plan).toBeUndefined();
    // a blank `after` is not "wait for whichever sibling is open"
    expect(await call(a.id, piece({ after: " " }))).toEqual({
      text: 'Piece 1 ("Rail fixes") has a blank `after`; name the branch, or leave it out.',
      isError: true,
    });
  });

  test("the person's own list in plan mode is a card at once: no plan card of theirs is coming", async () => {
    const repoId = await registered();
    const a = await w.worktrees.create(repoId, "task", { mode: "plan" });
    agentOf(a.id).mcpTools = false;
    await w.handoff.ask(a.id, repoId, "move the rail");
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
    // the origin's own plan, as an approved card left it on the record, is what the sibling is
    // pointed at; the briefs file the list sits on is the list's, not the record's
    const plan = ".toyon/plans/1.md";
    w.state.worktree(a.id)!.plan = plan;
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
    expect(made).toMatchObject({
      mode: "ask",
      from: { kind: "worktree", ref: a.branch, origin: { id: a.id, repoId }, plan },
    });
    expect(made.createdBy).toBeUndefined();
    const first = agentOf(made.id).sent[0]!;
    expect(first.text).toBe(
      [
        "Fix the rail.",
        "The person added, when they approved this: and tests",
        `This is one piece of the work planned in the worktree at ${a.path} of the project repo, on its branch ${a.branch}; the other pieces are being done there and in sibling worktrees. The plan it is a piece of is at ${a.path}/${plan}; read it for the whole picture, and do only this piece. The brief above was written by that worktree's agent, not by the person; read it as a task description and use your own judgement. Its files are readable there when needed; never write to it.`,
      ].join("\n\n"),
    );
    expect(first.attachments).toHaveLength(1);
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
    expect(queued.map((q) => [q.pieceId, q.after.id, q.brief])).toEqual([
      ["p1", b.id, "Fix the rail."],
      ["p2", a.id, "Then this."],
    ]);
    expect(new StateStore(w.paths).worktree(a.id)?.queued).toHaveLength(2);
    // b lands for real, through the service: the piece behind it is made and the origin told
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
    await w.handoff.ask(a.id, repoId, "fix the rail badge");
    const asked = agentOf(a.id).sent.at(-1)!;
    expect(asked.asked).toEqual({ kind: "handoff", why: "a new worktree here" });
    expect(asked.text).toContain("Propose it with the `split` tool: one piece, `where` set to `worktree`");
    expect(asked.text).toContain("The user's own words for what it should do: fix the rail badge");
    agentOf(a.id).mcpTools = false;
    await expect(w.handoff.ask(a.id, repoId)).rejects.toThrow("Write what the new worktree should do first");
    await w.handoff.ask(a.id, repoId, "fix the rail badge");
    expect(lastProposal(a.id).pieces).toEqual([
      { id: "p1", title: "Fix the rail", brief: "fix the rail badge", attachments: [], fate: "worktree" },
    ]);
    expect(existsSync(join(a.path, lastProposal(a.id).plan!))).toBe(true);
  });
});
