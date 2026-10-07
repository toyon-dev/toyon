import { describe, expect, test } from "bun:test";
import type { ChatItem } from "../../state/store.ts";
import { type OfferStanding, offerOf } from "./offer.ts";

const failed = (id: string, command: string, name = "shell"): ChatItem => ({
  kind: "tool",
  id,
  name,
  input: { command },
  output: "```\n1 fail\n```\nexit 1",
  isError: true,
  done: true,
  toolKind: "execute",
  fixable: { kind: name === "check" ? "check" : "command" },
});
const passed = (id: string, command: string): ChatItem => ({
  kind: "tool",
  id,
  name: "check",
  input: { command },
  output: "",
  done: true,
  toolKind: "execute",
});
const rest: OfferStanding = { queued: 0, sending: false, card: false, dismissed: new Set() };

describe("offerOf", () => {
  test("a failed command the daemon marked, last in the chat, is offered by its row", () => {
    expect(offerOf([{ kind: "user", text: "hi" }, failed("t1", "bun test")], rest)).toEqual({
      verb: "fix",
      toolId: "t1",
      command: "bun test",
    });
  });

  test("nothing for a failure the daemon did not mark, or a row still running", () => {
    const { fixable: _mark, ...unmarked } = failed("t1", "git push") as Extract<ChatItem, { kind: "tool" }>;
    expect(offerOf([unmarked], rest)).toBeNull();
    expect(offerOf([{ ...failed("t1", "bun test"), done: false } as ChatItem], rest)).toBeNull();
    expect(offerOf([], rest)).toBeNull();
  });

  test("anything after the row retires it: a later pass, a reply, another row", () => {
    const row = failed("t1", "bun run check", "check");
    expect(offerOf([row, passed("t2", "bun run check")], rest)).toBeNull();
    expect(offerOf([row, { kind: "assistant", text: "Looking." }], rest)).toBeNull();
    expect(offerOf([row, { kind: "user", text: "never mind" }], rest)).toBeNull();
  });

  test("a row Toyon already asked the agent about is not offered again", () => {
    const row = failed("t1", "bun run check", "check");
    expect(offerOf([row, { kind: "asked", why: "the check failed", toolId: "t1" }], rest)).toBeNull();
    // the ask about an earlier check leaves the next failure on offer: the cap held the daemon back
    const again = failed("t2", "bun run check", "check");
    expect(offerOf([row, { kind: "asked", why: "the check failed", toolId: "t1" }, again], rest)).toMatchObject({
      toolId: "t2",
    });
  });

  test("nothing while a message is queued or going out, or a question is up", () => {
    const chat = [failed("t1", "bun test")];
    expect(offerOf(chat, { ...rest, queued: 1 })).toBeNull();
    expect(offerOf(chat, { ...rest, sending: true })).toBeNull();
    expect(offerOf(chat, { ...rest, card: true })).toBeNull();
  });

  test("an offer turned down stays down, by its row", () => {
    const chat = [failed("t1", "bun test")];
    expect(offerOf(chat, { ...rest, dismissed: new Set(["t1"]) })).toBeNull();
    expect(offerOf(chat, { ...rest, dismissed: new Set(["t0"]) })).not.toBeNull();
  });
});
