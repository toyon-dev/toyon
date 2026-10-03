import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_MAX_CHARS, IMAGE_MAX_BYTES } from "@toyon/shared";
import { UploadStore, uploadIds } from "./uploads.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
/** `waitMs` is how long an upload nothing names is kept; the tests that watch one go set it short */
function make(waitMs?: number) {
  const dir = mkdtempSync(join(tmpdir(), "toyon-uploads-"));
  dirs.push(dir);
  return { dir, store: new UploadStore(dir, waitMs) };
}
const WAIT = 20;
const waited = () => Bun.sleep(WAIT * 4);
const bytes = (s: string) => [Buffer.from(s)];
const put = async (store: UploadStore, body = "notes") => (await store.put("file", "text/plain", bytes(body))).upload;

describe("UploadStore.put", () => {
  test("an image is written under its type and a file under none of its own", async () => {
    const { store, dir } = make();
    const img = await store.put("image", "image/jpeg", bytes("jpeg"));
    expect(img).toEqual({ upload: img.upload, bytes: 4, text: false });
    expect(store.path(img.upload)).toBe(join(dir, `${img.upload}.jpg`));
    expect(store.imageType(img.upload)).toBe("image/jpeg");
    // whatever the browser called it: a page is stored as bytes, not as a page
    const page = await store.put("file", "text/html", bytes("<script>alert(1)</script>"));
    expect(store.path(page.upload)).toBe(join(dir, `${page.upload}.bin`));
    expect(store.imageType(page.upload)).toBeNull();
    expect(await Bun.file(store.path(page.upload)!).text()).toBe("<script>alert(1)</script>");
  });

  test("says whether the bytes read as text", async () => {
    const { store } = make();
    expect((await store.put("file", "", bytes('{"a":"é"}\n'))).text).toBe(true);
    expect((await store.put("file", "", [Buffer.from([0xff, 0xfe, 0x00])])).text).toBe(false);
    // a NUL is valid UTF-8 and still not something to show
    expect((await store.put("file", "", [Buffer.from([0x61, 0x00, 0x62])])).text).toBe(false);
    // a character split across two chunks is still one character
    const e = Buffer.from("é");
    expect((await store.put("file", "", [e.subarray(0, 1), e.subarray(1)])).text).toBe(true);
    // past what a chip would show, nobody asks
    expect((await store.put("file", "", [Buffer.alloc(FILE_MAX_CHARS + 1, 0x61)])).text).toBe(false);
  });

  test("refuses an image of a type the models do not take, one over the cap, and an empty body", async () => {
    const { store, dir } = make();
    await expect(store.put("image", "image/svg+xml", bytes("<svg/>"))).rejects.toThrow("not an image format");
    await expect(store.put("image", "image/png", [Buffer.alloc(IMAGE_MAX_BYTES + 1)])).rejects.toThrow("larger than");
    await expect(store.put("file", "text/plain", [])).rejects.toThrow("empty file");
    await expect(store.put("file", "text/plain", null)).rejects.toThrow("empty file");
    // a refusal leaves nothing behind
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("UploadStore lifetime", () => {
  test("an upload a list lets go of is deleted at once; a named one stays", async () => {
    const { store } = make();
    const a = await put(store);
    const b = await put(store);
    store.keep([a, b]);
    store.keep([b]);
    expect(store.path(a)).toBeNull();
    expect(existsSync(store.path(b)!)).toBe(true);
    store.keep([]);
    expect(store.path(b)).toBeNull();
  });

  test("a send takes the box and a refusal puts it back: the upload is held across the gap", async () => {
    const { store } = make();
    const id = await put(store);
    store.keep([id]);
    // held before the box is emptied
    store.hold([id]);
    store.keep([]);
    expect(store.path(id)).not.toBeNull();
    // the box names it again before the hold is released
    store.keep([id]);
    store.release([id]);
    expect(store.path(id)).not.toBeNull();
  });

  test("a held upload outlives its box, across two variants, until the last one lets go", async () => {
    const { store } = make();
    const id = await put(store);
    store.keep([id]);
    // one message per variant, each naming the same upload
    store.hold([id]);
    store.hold([id]);
    // the box empties as the message is sent
    store.keep([]);
    expect(store.path(id)).not.toBeNull();
    store.release([id]);
    expect(store.path(id)).not.toBeNull();
    store.release([id]);
    expect(store.path(id)).toBeNull();
  });

  test("a released upload a box still names stays", async () => {
    const { store } = make();
    const id = await put(store);
    store.keep([id]);
    store.hold([id]);
    store.release([id]);
    expect(store.path(id)).not.toBeNull();
  });

  test("holding an upload that is gone is refused whole, in words for the person", async () => {
    const { store } = make();
    const id = await put(store);
    expect(store.has(id)).toBe(true);
    expect(store.has("nope")).toBe(false);
    expect(() => store.hold([id, "nope"])).toThrow("attach it again");
    // none were taken: once its box lets go, no hold keeps it
    store.keep([id]);
    store.keep([]);
    expect(store.path(id)).toBeNull();
  });

  test("an upload no list ever names goes after a while; a named or a held one stays", async () => {
    const dir = mkdtempSync(join(tmpdir(), "toyon-uploads-"));
    dirs.push(dir);
    const store = new UploadStore(dir, 20);
    const orphan = await put(store);
    const named = await put(store);
    const held = await put(store);
    store.keep([named]);
    store.hold([held]);
    await Bun.sleep(60);
    expect(store.path(orphan)).toBeNull();
    expect(store.path(named)).not.toBeNull();
    // the message that holds it is the one that lets it go
    expect(store.path(held)).not.toBeNull();
    store.release([held]);
    expect(store.path(held)).toBeNull();
    expect(readdirSync(dir)).toEqual([`${named}.bin`]);
  });

  test("a stored copy is adopted as a new upload, which waits to be named like any other", async () => {
    const { store, dir } = make(WAIT);
    const from = join(dir, "kept.png");
    await Bun.write(from, "png bytes");
    const img = await store.adopt(from, "image/png");
    expect(store.imageType(img)).toBe("image/png");
    expect(await Bun.file(store.path(img)!).text()).toBe("png bytes");
    const file = await store.adopt(from, null);
    expect(store.path(file)).toBe(join(dir, `${file}.bin`));
    store.keep([img]);
    await waited();
    expect(store.path(img)).not.toBeNull();
    expect(store.path(file)).toBeNull();
    // the copy it was made from is its own
    expect(existsSync(from)).toBe(true);
  });

  test("a new store finds what is on disk, and the boot sweep keeps only what a list names", async () => {
    const { store, dir } = make();
    const kept = await put(store);
    const left = await put(store);
    const img = (await store.put("image", "image/png", bytes("png"))).upload;
    const next = new UploadStore(dir);
    expect(next.imageType(img)).toBe("image/png");
    next.sweep([kept]);
    expect(next.path(kept)).not.toBeNull();
    expect(next.path(left)).toBeNull();
    expect(readdirSync(dir)).toEqual([`${kept}.bin`]);
  });
});

describe("uploadIds", () => {
  test("names the uploads behind images and files, and nothing for what rides in the frame", () => {
    expect(
      uploadIds([
        { kind: "paste", text: "x" },
        { kind: "image", name: "a.png", mimeType: "image/png", upload: "u1", bytes: 1, width: 1, height: 1 },
        { kind: "file", name: "a.txt", upload: "u2", bytes: 1, text: true },
      ]),
    ).toEqual(["u1", "u2"]);
    expect(uploadIds(undefined)).toEqual([]);
  });
});
