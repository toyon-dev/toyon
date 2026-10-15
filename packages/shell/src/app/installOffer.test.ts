import { describe, expect, test } from "bun:test";
import type { ChatItem } from "../state/store.ts";
import { installOfferDue } from "./installOffer.ts";

const prompt = { prompt: () => Promise.resolve() };
const said: ChatItem[] = [
  { kind: "user", text: "add a footer" },
  { kind: "assistant", text: "Done." },
];

describe("when the composer offers the install", () => {
  test("once the first reply has landed and the agent is idle", () => {
    expect(installOfferDue({ prompt, offered: false, agent: "idle", chat: said })).toBe(true);
  });

  test("not before anything has been said back", () => {
    expect(installOfferDue({ prompt, offered: false, agent: "idle", chat: [said[0]!] })).toBe(false);
    expect(installOfferDue({ prompt, offered: false, agent: "idle", chat: [] })).toBe(false);
  });

  test("not mid-turn: the pause is where it is read", () => {
    expect(installOfferDue({ prompt, offered: false, agent: "working", chat: said })).toBe(false);
    expect(installOfferDue({ prompt, offered: false, agent: "waiting", chat: said })).toBe(false);
  });

  test("never where the browser cannot install, and never twice", () => {
    expect(installOfferDue({ prompt: null, offered: false, agent: "idle", chat: said })).toBe(false);
    expect(installOfferDue({ prompt, offered: true, agent: "idle", chat: said })).toBe(false);
  });
});
