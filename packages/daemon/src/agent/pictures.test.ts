import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMAGE_MAX_BYTES } from "@toyon/shared";
import { AttachmentStore, attachmentsDirFor } from "./attachments.ts";
import { adoptPicture, pictureLinks, picturePath } from "./pictures.ts";
import { UploadStore } from "./uploads.ts";

const dir = mkdtempSync(join(tmpdir(), "toyon-pictures-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const store = new AttachmentStore(join(dir, "store"), new UploadStore(join(dir, "uploads")));
const cwd = join(dir, "wt");
mkdirSync(join(cwd, "out"), { recursive: true });
writeFileSync(join(cwd, "out", "offered.png"), "png!");
writeFileSync(join(dir, "shot.jpg"), "jpg!");
writeFileSync(join(dir, "notes.txt"), "text");

describe("pictureLinks", () => {
  test("finds the targets of whole markdown images, as written, once each", () => {
    const text = 'see ![offer](/tmp/a.png) and ![again](/tmp/a.png), then ![b](out/b.png "the title")';
    expect(pictureLinks(text)).toEqual(["/tmp/a.png", "out/b.png"]);
  });

  test("leaves a web image to the browser and a link that is not an image alone", () => {
    expect(pictureLinks("![x](https://e.com/a.png) [file](/tmp/a.png) ![d](data:image/png;base64,AA==)")).toEqual([]);
  });

  test("waits for a link still being written, and skips one shown inside a fence", () => {
    expect(pictureLinks("so ![offer](/tmp/a.pn")).toEqual([]);
    expect(pictureLinks("```md\n![x](/tmp/a.png)\n```\n![y](/tmp/b.png)")).toEqual(["/tmp/b.png"]);
  });
});

describe("picturePath", () => {
  test("reads a file URL and a relative path from the worktree", () => {
    expect(picturePath("file:///tmp/a%20b.png", "/w")).toBe("/tmp/a b.png");
    expect(picturePath("out/a.png", "/w")).toBe("/w/out/a.png");
    expect(picturePath("/private/tmp/a.png", "/w")).toBe("/private/tmp/a.png");
  });
});

describe("adoptPicture", () => {
  test("copies the file under its bytes' name and answers the event the chat draws it from", async () => {
    const picture = await adoptPicture(store, "wt-1", cwd, "out/offered.png");
    expect(picture).toEqual({
      path: "out/offered.png",
      file: expect.stringMatching(/^[0-9a-f]{16}\.png$/),
      mimeType: "image/png",
      bytes: 4,
    });
    expect(existsSync(join(attachmentsDirFor(store.dir, "wt-1"), picture?.file ?? ""))).toBe(true);
    const again = await adoptPicture(store, "wt-1", cwd, join(cwd, "out", "offered.png"));
    expect(again?.file).toBe(picture?.file);
    expect((await adoptPicture(store, "wt-1", cwd, join(dir, "shot.jpg")))?.mimeType).toBe("image/jpeg");
  });

  test("answers nothing for a file that is not there, not a picture, or too large", async () => {
    expect(await adoptPicture(store, "wt-1", cwd, "/nowhere/a.png")).toBeNull();
    expect(await adoptPicture(store, "wt-1", cwd, join(dir, "notes.txt"))).toBeNull();
    expect(await adoptPicture(store, "wt-1", cwd, dir)).toBeNull();
    writeFileSync(join(dir, "big.png"), Buffer.alloc(IMAGE_MAX_BYTES + 1));
    expect(await adoptPicture(store, "wt-1", cwd, join(dir, "big.png"))).toBeNull();
  });
});
