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
    const sent: unknown[] = [];
    const sock = { send: (m: unknown) => sent.push(m), urls: { host: "localhost" } } as never;
    const items = archivedItems(archived({ sessionId: "s-1" }), desk, { sock, dispatch: () => {} });
    expect(labels(items)).toEqual([
      "restore",
      "|",
      "copy branch name",
      "reveal transcript in Finder",
      "copy session id",
      "|",
      "delete…",
    ]);
    items
      .filter(isItem)
      .find((i) => i.id === "reveal")
      ?.onClick?.();
    expect(sent).toEqual([{ t: "reveal-transcript", worktreeId: "z" }]);
    expect(labels(archivedItems(archived(), desk, deps))).not.toContain("copy session id");
    // Finder is the daemon's screen: from another device the row is not offered
    const away = { send: () => {}, urls: { host: "box.tail1234.ts.net" } } as never;
    expect(labels(archivedItems(archived(), desk, { sock: away, dispatch: () => {} }))).not.toContain(
      "reveal transcript in Finder",
    );
  });

  test("on the phone the session id goes, since there is no shell to paste it into", () => {
    const phone = { clientId: "c", frame: "phone" as const };
    expect(labels(archivedItems(archived({ sessionId: "s-1" }), phone, deps))).toEqual([
      "restore",
      "|",
      "copy branch name",
      "reveal transcript in Finder",
      "|",
      "delete…",
    ]);
  });
});
