import { describe, expect, test } from "bun:test";
import type { ChatItem } from "../state/store.ts";
import { globalFailedText, globalOfferDue } from "./globalInstall.ts";

const said: ChatItem[] = [
  { kind: "user", text: "add a footer" },
  { kind: "assistant", text: "Done." },
];

describe("when the composer offers the global install", () => {
  test("once the first reply has landed and the agent is idle", () => {
    expect(globalOfferDue({ offer: { state: "offered" }, agent: "idle", chat: said })).toBe(true);
    expect(globalOfferDue({ offer: { state: "offered" }, agent: "idle", chat: [said[0]!] })).toBe(false);
    expect(globalOfferDue({ offer: { state: "offered" }, agent: "working", chat: said })).toBe(false);
  });

  test("never where the daemon has nothing to offer", () => {
    expect(globalOfferDue({ offer: null, agent: "idle", chat: said })).toBe(false);
  });

  test("a press is answered wherever the person is, chat or no chat", () => {
    expect(globalOfferDue({ offer: { state: "installing" }, agent: "working", chat: [] })).toBe(true);
    expect(globalOfferDue({ offer: { state: "installed" }, agent: undefined, chat: [] })).toBe(true);
  });
});

describe("what a failed global install says", () => {
  test("a permissions refusal points at npm's guide", () => {
    const t = globalFailedText({ line: "npm error code EACCES.", command: "npm install -g toyon@0.3.0" });
    expect(t).toEqual({ why: "npm error code EACCES", permissions: true, command: "npm install -g toyon@0.3.0" });
  });

  test("any other failure is npm's line alone", () => {
    expect(globalFailedText({ line: "npm error 404 Not Found", command: "x" }).permissions).toBe(false);
  });
});
