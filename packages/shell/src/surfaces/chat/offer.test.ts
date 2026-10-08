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
      key: "t1",
      toolId: "t1",
      command: "bun test",
    });
  });

  test("a stop or an error the last turn ended on offers to go on, keyed by its place", () => {
    const stop = { kind: "stopped", seq: 7 } as const;
    const error = { kind: "error", text: "API Error: 529", seq: 9 } as const;
    expect(offerOf([{ kind: "user", text: "hi" }, stop], rest)).toEqual({
      verb: "continue",
      key: "stopped:7",
      after: "stop",
    });
    expect(offerOf([error], rest)).toEqual({ verb: "continue", key: "error:9", after: "error" });
    // the ask the press sends lands after the row and retires it; so does anything else
    expect(offerOf([stop, { kind: "asked", about: "stopped", why: "to go on after the stop" }], rest)).toBeNull();
    expect(offerOf([error, { kind: "assistant", text: "Back." }], rest)).toBeNull();
    expect(offerOf([stop], { ...rest, dismissed: new Set(["stopped:7"]) })).toBeNull();
    // a line the daemon answered a press with is not the turn's end
    expect(offerOf([{ kind: "error", text: "nothing runs on main" }], rest)).toBeNull();
  });

  test("the same error straight after a press that went on after it is offered as a repeat", () => {
    const limit = "You've hit your session limit · resets 2:20pm (Europe/Berlin)";
    const pressed = { kind: "asked", about: "failed", why: "to go on after the error" } as const;
    const again = [{ kind: "error", text: limit, seq: 3 }, pressed, { kind: "error", text: limit, seq: 5 }] as const;
    expect(offerOf([...again], rest)).toEqual({ verb: "continue", key: "error:5", after: "error", again: true });
    // a different error, a turn that said something first, or a press after a stop: a fresh chance
    expect(offerOf([{ kind: "error", text: "overloaded", seq: 3 }, pressed, again[2]], rest)).not.toHaveProperty(
      "again",
    );
    expect(offerOf([again[0], pressed, { kind: "assistant", text: "On it." }, again[2]], rest)).not.toHaveProperty(
      "again",
    );
    expect(offerOf([again[0], { ...pressed, about: "stopped" }, again[2]], rest)).not.toHaveProperty("again");
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
    const asked = { kind: "asked", about: "check", why: "the check failed", toolId: "t1" } as const;
    expect(offerOf([row, asked], rest)).toBeNull();
    // the ask about an earlier check leaves the next failure on offer: the cap held the daemon back
    const again = failed("t2", "bun run check", "check");
    expect(offerOf([row, asked, again], rest)).toMatchObject({
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
