import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PasteSource } from "@toyon/shared";
import { FILE_INLINE_CHARS } from "@toyon/shared";
import { AttachmentStore, attachmentsDirFor, drawnType, type Stored, storedName, toolImage } from "./attachments.ts";
import { UploadStore } from "./uploads.ts";

const dir = mkdtempSync(join(tmpdir(), "toyon-attachments-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const uploads = new UploadStore(join(dir, "uploads"));
const store = new AttachmentStore(dir, uploads);
const img = async (mimeType: "image/png" | "image/jpeg" = "image/png") => ({
  kind: "image" as const,
  name: "a b.png",
  mimeType,
  upload: (await uploads.put("image", mimeType, [Buffer.from("png!")])).upload,
  bytes: 4,
  width: 4,
  height: 3,
});
const file = async (name: string, body = "{}\n") => ({
  kind: "file" as const,
  name,
  ...(await uploads.put("file", "application/octet-stream", [Buffer.from(body)])),
});
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
    const stored = await store.put("wt-1", 7, await img());
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
    // where the caption sends a tool that wants the picture as a file
    expect(stored.kind === "image" && stored.path).toBe(join(dir, "wt-1", "7.png"));
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
  test("jpeg gets .jpg; an upload that is gone, or was never taken as that image, is a user error", async () => {
    const jpeg = await store.put("wt-1", 8, await img("image/jpeg"));
    expect(jpeg.ref.kind === "image" && jpeg.ref.file).toBe("8.jpg");
    await expect(store.put("wt-1", 9, { ...(await img()), upload: "nope" })).rejects.toThrow("attach it again");
    // a file's upload was never held to the image caps, so it cannot be recorded as one
    const loose = await file("big.png");
    await expect(store.put("wt-1", 9, { ...(await img()), upload: loose.upload })).rejects.toThrow("attach it again");
  });
  test("a file is copied as <n>-<name>, its name reduced to what a path takes, and says where it is", async () => {
    const stored = await store.put("wt-1", 2, await file("run log (1).jsonl"));
    expect(stored.ref).toEqual({
      kind: "file",
      n: 2,
      name: "run log (1).jsonl",
      bytes: 3,
      text: true,
      file: "2-run_log_1_.jsonl",
    });
    const path = join(dir, "wt-1", "2-run_log_1_.jsonl");
    expect(stored.kind === "file" && stored.path).toBe(path);
    expect(await Bun.file(path).text()).toBe("{}\n");
    expect(store.fileFor("wt-1", "2-run_log_1_.jsonl")).toBe(path);
    // short text goes to the prompt with the path; long text, and bytes that are not text
    // whatever the sender says of them, go as the path alone
    expect(stored.kind === "file" && stored.text).toBe("{}\n");
    const long = await store.put("wt-1", 4, await file("long.log", "x".repeat(FILE_INLINE_CHARS + 1)));
    expect(long.kind === "file" && long.text).toBeUndefined();
    const edge = await store.put("wt-1", 5, await file("edge.log", "é".repeat(FILE_INLINE_CHARS)));
    expect(edge.kind === "file" && edge.text?.length).toBe(FILE_INLINE_CHARS);
    const binary = await uploads.put("file", "", [Buffer.from([0xff, 0xfe, 0x01])]);
    const lied = await store.put("wt-1", 6, { kind: "file", name: "a.bin", ...binary, text: true });
    expect(lied.kind === "file" && lied.text).toBeUndefined();
    await expect(store.put("wt-1", 3, { ...(await file("x")), upload: "nope" })).rejects.toThrow("attach it again");
  });
  test("a stored name keeps its extension when it is cut, and is never empty or hidden", () => {
    expect(storedName("../../etc/passwd")).toBe("_.._etc_passwd");
    expect(storedName("日本語")).toBe("_");
    expect(storedName("")).toBe("file");
    expect(storedName(".env")).toBe("env");
    const long = storedName(`${"a".repeat(200)}.jsonl`);
    expect(long).toHaveLength(80);
    expect(long).toEndWith(".jsonl");
  });
  test("only an image's own name is served as an image: a file that ends in .png is plain text", () => {
    expect(drawnType("7.png")).toBe("image/png");
    expect(drawnType("53ec22c455168e29.jpg")).toBe("image/jpeg");
    expect(drawnType("3.txt")).toBeNull();
    expect(drawnType("1-evil.png")).toBeNull();
    expect(drawnType("1-page.html")).toBeNull();
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
  test("what an archived chat's message carried is found where the archive keeps it", async () => {
    const stored = await store.put("wt-arch", 1, await file("notes.md", "# notes\n"));
    // the chat was archived: its files moved out of the store with it
    const moved = join(dir, "moved-notes.md");
    renameSync(join(dir, "wt-arch", "1-notes.md"), moved);
    expect(await store.reattach("wt-arch", stored.ref)).toBeNull();
    const again = await store.reattach("wt-arch", stored.ref, (f) => (f === "1-notes.md" ? moved : null));
    expect(again).toMatchObject({ kind: "file", name: "notes.md", bytes: 8, text: true });
    expect(await Bun.file(uploads.path(again?.kind === "file" ? again.upload : "")!).text()).toBe("# notes\n");
  });
  test("a picked element is its own ref and writes nothing", async () => {
    expect((await store.put("wt-3", 1, pick)).ref).toEqual({ ...pick, n: 1 });
    expect(existsSync(attachmentsDirFor(dir, "wt-3"))).toBe(false);
  });
  test("kinds are numbered apart, so <n> can repeat without colliding", async () => {
    const i = await store.put("wt-2", 1, await img());
    const p = await store.put("wt-2", 1, paste("hello"));
    const f = await store.put("wt-2", 1, await file("1.txt"));
    expect([i.ref, p.ref, f.ref]).toMatchObject([{ file: "1.png" }, { file: "1.txt" }, { file: "1-1.txt" }]);
  });
  test("a worktree id that is not one of ours is refused before anything is written", async () => {
    await expect(store.put("../x", 1, await img())).rejects.toThrow("bad worktree id");
  });
  test("fileFor refuses anything that is not one of our names", () => {
    expect(store.fileFor("../x", "1.png")).toBeNull();
    expect(store.fileFor("wt-1", "../1.png")).toBeNull();
    expect(store.fileFor("wt-1", "1.svg")).toBeNull();
    expect(store.fileFor("wt-1", "a.png")).toBeNull();
    expect(store.fileFor("wt-1", "1.txt.exe")).toBeNull();
    expect(store.fileFor("wt-1", "1-a/b")).toBeNull();
    expect(store.fileFor("wt-1", "-a.txt")).toBeNull();
  });
});
