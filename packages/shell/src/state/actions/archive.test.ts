import { describe, expect, test } from "bun:test";
import type { ArchivedWorktree } from "@toyon/shared";
import { isItem, type MenuEntry } from "../../ui/menu.ts";
import { archivedItems } from "./archive.ts";

const archived = (over: Partial<ArchivedWorktree> = {}): ArchivedWorktree => ({
  id: "z",
  repoId: "r",
  title: "side",
  branch: "toyon/side",
  path: "/w/z",
  createdAt: 0,
  archivedAt: 1,
  restorable: true,
  transcript: "/a/z/transcript.jsonl",
  ...over,
});

const deps = { sock: null, dispatch: () => {} };
const desk = { clientId: "c", frame: "desk" as const };
const labels = (items: MenuEntry[]) => items.map((i) => (isItem(i) ? i.label : "|"));

describe("an archived worktree's actions", () => {
  test("still hand the chat over: the transcript moved with it, and the session id when it had one", () => {
    expect(labels(archivedItems(archived({ sessionId: "s-1" }), desk, deps))).toEqual([
      "restore",
      "|",
      "copy branch name",
      "copy transcript path",
      "copy session id",
      "|",
      "delete for good…",
    ]);
    expect(labels(archivedItems(archived(), desk, deps))).not.toContain("copy session id");
  });

  test("on the phone the paths go, since there is no shell to paste them into", () => {
    const phone = { clientId: "c", frame: "phone" as const };
    expect(labels(archivedItems(archived({ sessionId: "s-1" }), phone, deps))).toEqual([
      "restore",
      "|",
      "copy branch name",
      "|",
      "delete for good…",
    ]);
  });
});
