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
  const attachmentsFile = join(dir, "draft-attachments.json");
  const heard: Array<[string, string, string | undefined]> = [];
  hub.on("draftChanged", (boxId, text, clientId) => heard.push([boxId, text, clientId]));
  const lists: Array<[string, number, string | undefined]> = [];
  hub.on("attachmentsChanged", (boxId, items, clientId) => lists.push([boxId, items.length, clientId]));
  /** what the uploads were last told the lists name */
  const kept: string[][] = [];
  const uploads = { keep: (named: Iterable<string>) => void kept.push([...named]) };
  const deps = { file, attachmentsFile, hub, uploads };
  return { ...deps, deps, heard, lists, kept, store: new DraftStore({ ...deps, saveDelayMs }) };
}

const file = (upload: string) => ({ kind: "file" as const, upload, name: `${upload}.txt`, bytes: 1, text: true });
const paste = { kind: "paste" as const, text: "pasted" };

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
    const { store, file, deps } = make(60_000);
    store.set("wt-a", "one");
    store.set("draft:r1", "two");
    expect(existsSync(file)).toBe(false);
    store.flush();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ "wt-a": "one", "draft:r1": "two" });
    expect(new DraftStore(deps).all()).toEqual({ "wt-a": "one", "draft:r1": "two" });
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
    const { file, deps } = make();
    writeFileSync(file, "{not json");
    expect(new DraftStore(deps).all()).toEqual({});
  });
});

describe("DraftStore attachments", () => {
  test("a box's list is kept, told with its writer, and the uploads hear what the lists name", () => {
    const { store, lists, kept } = make();
    store.setAttachments("wt-a", [file("u1"), paste], "tab1");
    store.setAttachments("wt-a", [file("u1"), paste], "tab2");
    store.setAttachments("wt-b", [file("u2")]);
    expect(store.allAttachments()).toEqual({ "wt-a": [file("u1"), paste], "wt-b": [file("u2")] });
    expect(lists).toEqual([
      ["wt-a", 2, "tab1"],
      ["wt-b", 1, undefined],
    ]);
    expect(kept).toEqual([["u1"], ["u1", "u2"]]);
    store.setAttachments("wt-a", []);
    expect(store.allAttachments()).toEqual({ "wt-b": [file("u2")] });
    expect(kept.at(-1)).toEqual(["u2"]);
  });

  test("a box with chips and no words is written in", () => {
    const { store } = make();
    expect(store.has("wt-a")).toBe(false);
    store.setAttachments("wt-a", [paste]);
    expect(store.has("wt-a")).toBe(true);
  });

  test("the lists are their own file, so the text's file keeps its shape, and both read back", () => {
    const { store, file: textFile, attachmentsFile, deps } = make(60_000);
    store.set("wt-a", "one");
    store.setAttachments("wt-a", [file("u1")]);
    store.flush();
    expect(JSON.parse(readFileSync(textFile, "utf8"))).toEqual({ "wt-a": "one" });
    expect(JSON.parse(readFileSync(attachmentsFile, "utf8"))).toEqual({ "wt-a": [file("u1")] });
    const next = new DraftStore(deps);
    expect(next.attachments("wt-a")).toEqual([file("u1")]);
    expect(next.uploadIds()).toEqual(["u1"]);
  });

  test("an item in a shape this daemon does not read is dropped alone", () => {
    const { attachmentsFile, deps } = make();
    const old = { kind: "image", name: "a.png", mimeType: "image/png", data: "UE5H", width: 1, height: 1 };
    writeFileSync(attachmentsFile, JSON.stringify({ "wt-a": [old, paste], "wt-b": [old], "wt-c": "nope" }));
    expect(new DraftStore(deps).allAttachments()).toEqual({ "wt-a": [paste] });
  });

  test("move carries a box's words and chips together, and only over what is there when told to", () => {
    const { store, kept } = make();
    store.set("spare", "half a thought");
    store.setAttachments("spare", [file("u1")]);
    store.set("main", "already here");
    expect(store.move("spare", "main")).toBe(false);
    expect(store.text("main")).toBe("already here");
    expect(store.move("spare", "main", true)).toBe(true);
    expect([store.text("main"), store.attachments("main")]).toEqual(["half a thought", [file("u1")]]);
    expect([store.text("spare"), store.attachments("spare")]).toEqual(["", []]);
    // never unnamed on the way: the new box named the upload before the old one let go
    expect(kept.every((ids) => ids.includes("u1"))).toBe(true);
    expect(store.move("empty", "main", true)).toBe(false);
    // chips alone take the box whole: the words that were there are not left under them
    store.setAttachments("spare", [file("u2")]);
    expect(store.move("spare", "main", true)).toBe(true);
    expect([store.text("main"), store.attachments("main")]).toEqual(["", [file("u2")]]);
  });

  test("take empties a box under the sender's name, and putBack fills it again around what is newer", () => {
    const { store, heard, lists, kept } = make();
    store.set("a", "what failed here", "tab1");
    store.setAttachments("a", [file("u1")], "tab1");
    heard.length = lists.length = kept.length = 0;
    expect(store.take("a", "tab1")).toEqual({ text: "what failed here", items: [file("u1")] });
    expect(store.has("a")).toBe(false);
    expect(heard).toEqual([["a", "", "tab1"]]);
    expect(lists).toEqual([["a", 0, "tab1"]]);
    expect(kept).toEqual([[]]);
    // an empty box takes the words and the chips back
    store.putBack("a", { text: "what failed here", items: [file("u1")] }, "tab1");
    expect(store.text("a")).toBe("what failed here");
    expect(store.attachments("a")).toEqual([file("u1")]);
    expect(kept.at(-1)).toEqual(["u1"]);
    // a box written in since keeps its words, and its chips come after what returns
    store.take("a");
    store.set("a", "second thought");
    store.setAttachments("a", [file("u2")]);
    store.putBack("a", { text: "what failed here", items: [file("u1")] });
    expect(store.text("a")).toBe("second thought");
    expect(store.attachments("a")).toEqual([file("u1"), file("u2")]);
    // an empty box taken is nothing told
    heard.length = 0;
    expect(store.take("b")).toEqual({ text: "", items: [] });
    expect(heard).toEqual([]);
  });

  test("drop empties both, and prune drops the lists of boxes nothing names", () => {
    const { store, lists } = make();
    store.setAttachments("wt-a", [paste]);
    store.setAttachments("wt-gone", [paste]);
    lists.length = 0;
    store.prune((id) => id === "wt-a");
    expect(store.allAttachments()).toEqual({ "wt-a": [paste] });
    expect(lists).toEqual([]);
    store.drop("wt-a");
    expect(store.allAttachments()).toEqual({});
    expect(lists).toEqual([["wt-a", 0, undefined]]);
  });
});
