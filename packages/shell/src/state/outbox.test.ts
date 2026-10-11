import { describe, expect, test } from "bun:test";
import type { AttachmentInput } from "@toyon/shared";
import { fillFrame, namingFirst, outBoxId, outBoxOf, readyToGo } from "./outbox.ts";
import type { PendingAttachment } from "./pending.ts";

// What the outbox decides on its own: which box a waiting message is in, when it can go, and the
// order the daemon is told lists in so that an upload moving between boxes is never unnamed.

const landed: PendingAttachment = { kind: "file", key: "f1", upload: "u1", name: "run.jsonl", bytes: 9, text: true };
const flying: PendingAttachment = { ...landed, key: "f2", upload: "", uploading: true };
const paste: PendingAttachment = { kind: "paste", key: "p1", text: "hi", chars: 2, lines: 1, preview: "hi" };

describe("an outgoing box", () => {
  test("is named for the tab that holds it and the box the message left, whatever that box is called", () => {
    const id = outBoxId("tab-1", 3, "card:ask-9");
    expect(outBoxOf(id)).toEqual({ clientId: "tab-1", source: "card:ask-9" });
    expect(outBoxOf("card:ask-9")).toBeNull();
    expect(outBoxOf("out:broken")).toBeNull();
  });

  test("fills the frame with the words and the settled chips, by frame kind", () => {
    const items = [landed, paste];
    const sent: AttachmentInput[] = [
      { kind: "file", upload: "u1", name: "run.jsonl", bytes: 9, text: true },
      { kind: "paste", text: "hi" },
    ];
    expect(fillFrame({ t: "chat", worktreeId: "a" }, "out", "see", items)).toEqual({
      t: "chat",
      worktreeId: "a",
      text: "see",
      attachments: sent,
      boxId: "out",
    });
    expect(fillFrame({ t: "create-worktree", repoId: "r" }, "out", "see", [])).toEqual({
      t: "create-worktree",
      repoId: "r",
      prompt: "see",
      attachments: undefined,
      boxId: "out",
    });
    expect(fillFrame({ t: "restore-worktree", archiveId: "x" }, "out", "see", items)).toEqual({
      t: "restore-worktree",
      archiveId: "x",
      message: { text: "see", attachments: sent },
      boxId: "out",
    });
    expect(fillFrame({ t: "agent-answer", worktreeId: "a", askId: "q" }, "out", "", items)).toEqual({
      t: "agent-answer",
      worktreeId: "a",
      askId: "q",
      attachments: sent,
      boxId: "out",
    });
  });
});

describe("what can go", () => {
  test("a message goes once its uploads have landed, and never ahead of one sent before it to the same log", () => {
    const outbox = [
      { id: "o1", log: "a", kinds: [] },
      { id: "o2", log: "a", kinds: [] },
      { id: "o3", log: "b", kinds: [] },
    ];
    const local = { o1: { attachments: [flying] }, o2: { attachments: [landed] }, o3: { attachments: [landed] } };
    expect(readyToGo(outbox, local)).toEqual(["o3"]);
    expect(readyToGo(outbox, { ...local, o1: { attachments: [landed] } })).toEqual(["o1", "o2", "o3"]);
    // a box gone from under its entry blocks its log rather than sending what follows out of order
    expect(readyToGo(outbox, { o2: local.o2, o3: local.o3 })).toEqual(["o3"]);
  });
});

describe("telling the daemon lists", () => {
  test("a list that names an upload for the first time goes ahead of the one that stops naming it", () => {
    const named = [{ kind: "file", upload: "u1", name: "n", bytes: 1, text: true } as const];
    const frames = [
      { id: "a", items: [], before: ["u1"] },
      { id: "out", items: named, before: [] },
      { id: "c", items: named, before: ["u1"] },
    ];
    expect(namingFirst(frames).map((f) => f.id)).toEqual(["out", "a", "c"]);
  });
});
