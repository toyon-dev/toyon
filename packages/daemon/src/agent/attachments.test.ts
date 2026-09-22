import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PasteSource } from "@toyon/shared";
import { AttachmentStore, attachmentsDirFor, type Stored, toolImage } from "./attachments.ts";

const dir = mkdtempSync(join(tmpdir(), "toyon-attachments-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const store = new AttachmentStore(dir);
const img = {
  kind: "image" as const,
  name: "a b.png",
  mimeType: "image/png" as const,
  data: Buffer.from("png!").toString("base64"),
  width: 4,
  height: 3,
};
const paste = (text: string, more: { name?: string; source?: PasteSource } = {}) => ({
  kind: "paste" as const,
  text,
  ...more,
});
const pick = {
  kind: "pick" as const,
  component: "Button",
  file: "src/ui/Button.tsx",
  line: 4,
  callFile: null,
  callLine: null,
  tag: "button",
  selector: "main > button",
  text: "Save",
  html: "<button>Save</button>",
};
const bytesOf = (s: Stored) => ("bytes" in s ? s.bytes.toString() : null);
const textOf = (s: Stored) => ("text" in s ? s.text : null);

describe("AttachmentStore", () => {
  test("writes <worktree>/<n>.<ext> and hands back the ref the transcript keeps", async () => {
    const stored = await store.put("wt-1", 7, img);
    expect(stored.ref).toEqual({
      kind: "image",
      n: 7,
      name: "a b.png",
      mimeType: "image/png",
      bytes: 4,
      width: 4,
      height: 3,
      file: "7.png",
    });
    expect(bytesOf(stored)).toBe("png!");
    expect(existsSync(join(attachmentsDirFor(dir, "wt-1"), "7.png"))).toBe(true);
    expect(store.fileFor("wt-1", "7.png")).toBe(join(dir, "wt-1", "7.png"));
  });
  test("a tool's picture is named by its bytes and written once", async () => {
    const shot = toolImage(Buffer.from("png!").toString("base64"), "image/png");
    expect(shot?.ref).toEqual({ file: "53ec22c455168e29.png", mimeType: "image/png", bytes: 4 });
    expect(toolImage("", "image/png")).toBeNull();
    expect(toolImage(Buffer.from("x").toString("base64"), "image/tiff")).toBeNull();
    const file = shot!.ref.file;
    const first = store.putToolImage("wt-1", file, shot!.bytes);
    // named on the chat before the bytes land: the fetch waits on the write rather than 404ing
    await store.whenWritten("wt-1", file);
    await first;
    expect(existsSync(join(attachmentsDirFor(dir, "wt-1"), file))).toBe(true);
    await store.putToolImage("wt-1", file, Buffer.from("other"));
    expect(await Bun.file(join(dir, "wt-1", file)).text()).toBe("png!");
    expect(store.fileFor("wt-1", file)).toBe(join(dir, "wt-1", file));
    await expect(store.putToolImage("wt-1", "../x.png", shot!.bytes)).rejects.toThrow("bad tool image");
  });
  test("jpeg gets .jpg; an empty payload is a user error", async () => {
    const jpeg = await store.put("wt-1", 8, { ...img, mimeType: "image/jpeg" });
    expect(jpeg.ref.kind === "image" && jpeg.ref.file).toBe("8.jpg");
    await expect(store.put("wt-1", 9, { ...img, data: "" })).rejects.toThrow("empty image");
  });
  test("a paste is written as <n>.txt with the counts the chip and the caption use", async () => {
    const stored = await store.put("wt-1", 3, paste("line one\nline two"));
    expect(stored.ref).toEqual({ kind: "paste", n: 3, chars: 17, lines: 2, preview: "line one", file: "3.txt" });
    expect(textOf(stored)).toBe("line one\nline two");
    expect(store.fileFor("wt-1", "3.txt")).toBe(join(dir, "wt-1", "3.txt"));
  });
  test("a paste from a file keeps its name; an empty one is a user error", async () => {
    expect((await store.put("wt-1", 4, paste("x", { name: "App.tsx" }))).ref).toMatchObject({ name: "App.tsx" });
    await expect(store.put("wt-1", 5, paste(""))).rejects.toThrow("empty paste");
  });
  test("a paste copied in the editor keeps the file and lines it names", async () => {
    const source = { path: "src/App.tsx", startLine: 3, endLine: 9 };
    expect((await store.put("wt-1", 6, paste("x", { source }))).ref).toMatchObject({ source });
  });
  test("a picked element is its own ref and writes nothing", async () => {
    expect((await store.put("wt-3", 1, pick)).ref).toEqual({ ...pick, n: 1 });
    expect(existsSync(attachmentsDirFor(dir, "wt-3"))).toBe(false);
  });
  test("kinds are numbered apart, so <n> can repeat without colliding", async () => {
    const i = await store.put("wt-2", 1, img);
    const p = await store.put("wt-2", 1, paste("hello"));
    expect([i.ref, p.ref]).toMatchObject([{ file: "1.png" }, { file: "1.txt" }]);
  });
  test("a worktree id that is not one of ours is refused before anything is written", async () => {
    await expect(store.put("../x", 1, img)).rejects.toThrow("bad worktree id");
  });
  test("fileFor refuses anything that is not one of our names", () => {
    expect(store.fileFor("../x", "1.png")).toBeNull();
    expect(store.fileFor("wt-1", "../1.png")).toBeNull();
    expect(store.fileFor("wt-1", "1.svg")).toBeNull();
    expect(store.fileFor("wt-1", "a.png")).toBeNull();
    expect(store.fileFor("wt-1", "1.txt.exe")).toBeNull();
  });
});
