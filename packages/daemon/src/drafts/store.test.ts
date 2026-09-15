import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../core/hub.ts";
import { DraftStore } from "./store.ts";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function make(saveDelayMs = 0) {
  dir = mkdtempSync(join(tmpdir(), "toyon-drafts-"));
  const file = join(dir, "drafts.json");
  const hub = new Hub();
  const heard: Array<[string, string, string | undefined]> = [];
  hub.on("draftChanged", (boxId, text, clientId) => heard.push([boxId, text, clientId]));
  return { file, hub, heard, store: new DraftStore({ file, hub, saveDelayMs }) };
}

describe("DraftStore", () => {
  test("a box's text is kept, told to the hub with its writer, and an unchanged write says nothing", () => {
    const { store, heard } = make();
    store.set("wt-a", "half a thought", "tab1");
    store.set("wt-a", "half a thought", "tab2");
    expect(store.all()).toEqual({ "wt-a": "half a thought" });
    expect(store.has("wt-a")).toBe(true);
    expect(heard).toEqual([["wt-a", "half a thought", "tab1"]]);
  });

  test("an emptied box is forgotten, and whitespace alone is not a draft", () => {
    const { store } = make();
    store.set("wt-a", "  ");
    expect(store.has("wt-a")).toBe(false);
    store.set("wt-a", "");
    expect(store.all()).toEqual({});
  });

  test("writes wait for the delay, flush writes now, and a new store reads them back", async () => {
    const { store, file, hub } = make(60_000);
    store.set("wt-a", "one");
    store.set("draft:r1", "two");
    expect(existsSync(file)).toBe(false);
    store.flush();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ "wt-a": "one", "draft:r1": "two" });
    expect(new DraftStore({ file, hub }).all()).toEqual({ "wt-a": "one", "draft:r1": "two" });
  });

  test("drop tells the tabs the box is empty", () => {
    const { store, heard } = make();
    store.set("wt-a", "text");
    store.drop("wt-a");
    expect(store.all()).toEqual({});
    expect(heard.at(-1)).toEqual(["wt-a", "", undefined]);
  });

  test("prune keeps what is still named and drops the rest without telling anyone", () => {
    const { store, heard } = make();
    store.set("wt-a", "keep");
    store.set("wt-gone", "drop");
    heard.length = 0;
    store.prune((id) => id === "wt-a");
    expect(store.all()).toEqual({ "wt-a": "keep" });
    expect(heard).toEqual([]);
  });

  test("an unreadable file starts empty", () => {
    const { file, hub } = make();
    writeFileSync(file, "{not json");
    expect(new DraftStore({ file, hub }).all()).toEqual({});
  });
});
