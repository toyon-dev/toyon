import { describe, expect, test } from "bun:test";
import { imageFiles, otherFiles, readText } from "./images.ts";

// A DataTransfer as the browser hands it over. Only the shape the intake reads is modelled: the
// precedence rules are the point, not the DOM.
function transfer(files: Array<{ name: string; type: string }>, text?: Record<string, string>): DataTransfer {
  const list = files.map((f) => ({ ...f, kind: "file" as const, getAsFile: () => f as unknown as File }));
  return {
    items: list,
    files: files as unknown as FileList,
    getData: (k: string) => text?.[k] ?? "",
  } as unknown as DataTransfer;
}

describe("what the intake pulls out of a paste or drop", () => {
  test("an image is taken as an image", () => {
    const dt = transfer([{ name: "a.png", type: "image/png" }]);
    expect(imageFiles(dt).map((f) => f.name)).toEqual(["a.png"]);
    expect(otherFiles(dt)).toEqual([]);
  });

  test("a copied source file is not an image, and is not silently dropped", () => {
    const dt = transfer([{ name: "App.tsx", type: "text/plain" }]);
    expect(imageFiles(dt)).toEqual([]);
    expect(otherFiles(dt).map((f) => f.name)).toEqual(["App.tsx"]);
  });

  test("a file with no type at all still counts: Finder often sends one", () => {
    expect(otherFiles(transfer([{ name: "notes", type: "" }])).map((f) => f.name)).toEqual(["notes"]);
  });

  test("an image plus a text flavour keeps the image: a spreadsheet cell offers both", () => {
    const dt = transfer([{ name: "cell.png", type: "image/png" }], { "text/plain": "42" });
    expect(imageFiles(dt).map((f) => f.name)).toEqual(["cell.png"]);
    expect(otherFiles(dt)).toEqual([]);
  });

  test("the pasteboard's one picture listed in two encodings is one image, in the format the daemon takes", () => {
    const dt = transfer([
      { name: "image.tiff", type: "image/tiff" },
      { name: "image.png", type: "image/png" },
    ]);
    expect(imageFiles(dt).map((f) => f.name)).toEqual(["image.png"]);
  });

  test("a picture in no format the daemon takes still comes through, once", () => {
    const dt = transfer([
      { name: "image.tiff", type: "image/tiff" },
      { name: "image.bmp", type: "image/bmp" },
    ]);
    expect(imageFiles(dt).map((f) => f.name)).toEqual(["image.tiff"]);
  });

  test("a file copied in Finder is what was meant, not the browser's rendering of it", () => {
    const dt = transfer([
      { name: "image.png", type: "image/png" },
      { name: "shot.png", type: "image/png" },
    ]);
    expect(imageFiles(dt).map((f) => f.name)).toEqual(["shot.png"]);
  });

  test("several copied files each keep their place", () => {
    const dt = transfer([
      { name: "a.png", type: "image/png" },
      { name: "b.png", type: "image/png" },
    ]);
    expect(imageFiles(dt).map((f) => f.name)).toEqual(["a.png", "b.png"]);
  });

  test("one file listed under two flavours is one file", () => {
    const entry = { name: "a.png", type: "image/png", size: 10, lastModified: 5 };
    const dt = transfer([entry, { ...entry }]);
    expect(imageFiles(dt)).toHaveLength(1);
  });

  test("nothing to attach when the clipboard is only text", () => {
    const dt = transfer([], { "text/plain": "hello", "text/html": "<b>hello</b>" });
    expect(imageFiles(dt)).toEqual([]);
    expect(otherFiles(dt)).toEqual([]);
  });
});

describe("readText", () => {
  const file = (bytes: Uint8Array, size = bytes.length) =>
    ({ size, arrayBuffer: async () => bytes.buffer }) as unknown as File;

  test("decodes utf-8", async () => {
    expect(await readText(file(new TextEncoder().encode("hej så")))).toBe("hej så");
  });

  test("a binary comes back null rather than a screen of replacement characters", async () => {
    expect(await readText(file(new Uint8Array([0xff, 0xfe, 0x00, 0x80])))).toBeNull();
  });

  test("something enormous is not what anyone meant to paste", async () => {
    expect(await readText(file(new TextEncoder().encode("x"), 50 * 1024 * 1024))).toBeNull();
  });
});
