import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { COMPRESS_EXT, COMPRESS_MIN, compressFile, siblingSize } from "./precompress.ts";

const dir = mkdtempSync(join(tmpdir(), "toyon-precompress-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("compressFile", () => {
  test("a text asset gets both siblings, each decoding back to the source", async () => {
    const file = join(dir, "index-abc123.js");
    const source = "export const row = { id: 'wt', title: 'a worktree' };\n".repeat(400);
    writeFileSync(file, source);
    const sizes = await compressFile(file);
    expect(sizes.br).toBeGreaterThan(0);
    expect(sizes.gz).toBeGreaterThan(0);
    expect(sizes.br!).toBeLessThan(source.length / 4);
    expect(brotliDecompressSync(readFileSync(`${file}.br`)).toString()).toBe(source);
    expect(gunzipSync(readFileSync(`${file}.gz`)).toString()).toBe(source);
    expect(siblingSize(file, "br")).toBe(sizes.br!);
    expect(siblingSize(file, "gz")).toBe(sizes.gz!);
    expect(existsSync(`${file}.br.tmp`)).toBe(false);
  });

  test("a short sibling left by an interrupted build is rewritten whole", async () => {
    const file = join(dir, "chunk-def456.js");
    const source = "export default [1, 2, 3, 4, 5, 6, 7, 8];\n".repeat(200);
    writeFileSync(file, source);
    writeFileSync(`${file}.br`, "");
    await compressFile(file);
    expect(brotliDecompressSync(readFileSync(`${file}.br`)).toString()).toBe(source);
  });

  test("a small file is left alone", async () => {
    const file = join(dir, "tiny-000001.js");
    writeFileSync(file, "x".repeat(COMPRESS_MIN - 1));
    expect(await compressFile(file)).toEqual({ br: null, gz: null });
    expect(existsSync(`${file}.br`)).toBe(false);
    expect(siblingSize(file, "br")).toBeNull();
  });

  test("a file that barely shrinks is left alone", async () => {
    const file = join(dir, "noise-000002.js");
    const bytes = new Uint8Array(20 * 1024);
    crypto.getRandomValues(bytes);
    writeFileSync(file, bytes);
    expect(await compressFile(file)).toEqual({ br: null, gz: null });
    expect(existsSync(`${file}.gz`)).toBe(false);
  });
});

test("fonts and images are not candidates; text is", () => {
  for (const name of ["codicon-abc.ttf", "icon-abc.png", "font-abc.woff2"]) expect(COMPRESS_EXT.test(name)).toBe(false);
  for (const name of ["index-abc.js", "index-abc.css", "onig-abc.wasm", "icon-abc.svg"])
    expect(COMPRESS_EXT.test(name)).toBe(true);
});
