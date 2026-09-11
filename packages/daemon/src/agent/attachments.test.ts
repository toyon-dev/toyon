import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentStore, attachmentsDirFor } from "./attachments.ts";

const dir = mkdtempSync(join(tmpdir(), "toyon-attachments-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const store = new AttachmentStore(dir);
const img = {
  name: "a b.png",
  mimeType: "image/png" as const,
  data: Buffer.from("png!").toString("base64"),
  width: 4,
  height: 3,
};

describe("AttachmentStore", () => {
  test("writes <worktree>/<n>.<ext> and hands back the ref the transcript keeps", async () => {
    const { ref, bytes } = await store.putImage("wt-1", 7, img);
    expect(ref).toEqual({ n: 7, name: "a b.png", mimeType: "image/png", bytes: 4, width: 4, height: 3, file: "7.png" });
    expect(bytes.toString()).toBe("png!");
    expect(existsSync(join(attachmentsDirFor(dir, "wt-1"), "7.png"))).toBe(true);
    expect(store.fileFor("wt-1", "7.png")).toBe(join(dir, "wt-1", "7.png"));
  });
  test("jpeg gets .jpg; an empty payload is a user error", async () => {
    expect((await store.putImage("wt-1", 8, { ...img, mimeType: "image/jpeg" })).ref.file).toBe("8.jpg");
    await expect(store.putImage("wt-1", 9, { ...img, data: "" })).rejects.toThrow("empty image");
  });
  test("a paste is written as <n>.txt with the counts the chip and the caption use", async () => {
    const { ref, text } = await store.putText("wt-1", 3, "line one\nline two");
    expect(ref).toEqual({ n: 3, chars: 17, lines: 2, preview: "line one", file: "3.txt" });
    expect(text).toBe("line one\nline two");
    expect(store.fileFor("wt-1", "3.txt")).toBe(join(dir, "wt-1", "3.txt"));
  });
  test("a paste from a file keeps its name; an empty one is a user error", async () => {
    expect((await store.putText("wt-1", 4, "x", { name: "App.tsx" })).ref.name).toBe("App.tsx");
    await expect(store.putText("wt-1", 5, "")).rejects.toThrow("empty paste");
  });
  test("a paste copied in the editor keeps the file and lines it names", async () => {
    const source = { path: "src/App.tsx", startLine: 3, endLine: 9 };
    expect((await store.putText("wt-1", 6, "x", { source })).ref.source).toEqual(source);
  });
  test("images and pastes are numbered apart, so <n> can repeat without colliding", async () => {
    const i = await store.putImage("wt-2", 1, img);
    const p = await store.putText("wt-2", 1, "hello");
    expect([i.ref.file, p.ref.file]).toEqual(["1.png", "1.txt"]);
  });
  test("fileFor refuses anything that is not one of our names", () => {
    expect(store.fileFor("../x", "1.png")).toBeNull();
    expect(store.fileFor("wt-1", "../1.png")).toBeNull();
    expect(store.fileFor("wt-1", "1.svg")).toBeNull();
    expect(store.fileFor("wt-1", "a.png")).toBeNull();
    expect(store.fileFor("wt-1", "1.txt.exe")).toBeNull();
  });
});
