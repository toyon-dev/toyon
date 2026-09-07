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
    const { ref, bytes } = await store.put("wt-1", 7, img);
    expect(ref).toEqual({ n: 7, name: "a b.png", mimeType: "image/png", bytes: 4, width: 4, height: 3, file: "7.png" });
    expect(bytes.toString()).toBe("png!");
    expect(existsSync(join(attachmentsDirFor(dir, "wt-1"), "7.png"))).toBe(true);
    expect(store.fileFor("wt-1", "7.png")).toBe(join(dir, "wt-1", "7.png"));
  });
  test("jpeg gets .jpg; an empty payload is a user error", async () => {
    expect((await store.put("wt-1", 8, { ...img, mimeType: "image/jpeg" })).ref.file).toBe("8.jpg");
    await expect(store.put("wt-1", 9, { ...img, data: "" })).rejects.toThrow("empty image");
  });
  test("fileFor refuses anything that is not one of our names", () => {
    expect(store.fileFor("../x", "1.png")).toBeNull();
    expect(store.fileFor("wt-1", "../1.png")).toBeNull();
    expect(store.fileFor("wt-1", "1.svg")).toBeNull();
    expect(store.fileFor("wt-1", "a.png")).toBeNull();
  });
});
