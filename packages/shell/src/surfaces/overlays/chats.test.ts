import { describe, expect, test } from "bun:test";
import type { ChatHit } from "@toyon/shared";
import { type ChatRow, type ChatsRow, chatRows } from "./chats.ts";

const chat = (name: string, branch: string, prompt?: string): ChatRow => ({
  kind: "chat",
  id: name,
  name,
  hint: "",
  fields: [name, branch],
  prompt,
});
const hit = (text: string): ChatsRow => ({ kind: "hit", hit: { worktreeId: "w", seq: 0, text } as ChatHit });

const rows: ChatsRow[] = [
  chat("Scroll cause", "toyon/scroll-cause", "why does the log scroll"),
  chat("Panel toggle", "toyon/panel-toggle", "the panel should scroll shut"),
  hit("scroll the panel"),
];
const names = (out: ChatsRow[]) => out.map((r) => (r.kind === "chat" ? r.name : "hit"));

describe("chatRows", () => {
  test("nothing typed lists every chat and no hit", () => {
    expect(names(chatRows(rows, "", "all"))).toEqual(["Scroll cause", "Panel toggle"]);
    expect(names(chatRows(rows, "  ", "names"))).toEqual(["Scroll cause", "Panel toggle"]);
  });

  test("one character narrows the chats by name before the messages are searched", () => {
    expect(names(chatRows(rows, "p", "all"))).toEqual(["Panel toggle"]);
  });

  test("a query the daemon answers shows its hits under the chats named by it", () => {
    expect(names(chatRows(rows, "scroll", "all"))).toEqual(["Scroll cause", "hit"]);
  });

  test("names alone leaves the hits out and reads the first message as part of the name", () => {
    expect(names(chatRows(rows, "scroll", "names"))).toEqual(["Scroll cause", "Panel toggle"]);
    expect(names(chatRows(rows, "scroll shut", "names"))).toEqual(["Panel toggle"]);
  });
});
