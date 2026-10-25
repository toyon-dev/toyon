import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sharedFiles } from "./share.ts";

// The cache storage as the worker leaves it: one entry per shared file, the name in a header.
// Only what sharedFiles reads is modelled.
function storage(entries: Array<{ name: string; type: string; body: string }>) {
  const deleted: string[] = [];
  const keys = entries.map((_, i) => new Request(`http://t/share/${i}`));
  const byKey = new Map(
    entries.map((e, i) => [
      keys[i]!,
      // a blob body, as the worker's File is: bun adds a charset to a string body's type
      new Response(new Blob([e.body]), {
        headers: { "content-type": e.type, "x-toyon-name": encodeURIComponent(e.name) },
      }),
    ]),
  );
  const cache = {
    keys: async () => keys,
    match: async (req: Request) => byKey.get(req),
  };
  const s = {
    has: async (name: string) => name === "toyon-shared" && entries.length > 0,
    open: async () => cache,
    delete: async (name: string) => {
      deleted.push(name);
      return true;
    },
  } as unknown as CacheStorage;
  return { storage: s, deleted };
}

describe("files shared into the installed app", () => {
  test("come back as files, in the order shared, with their names and types, and the cache goes", async () => {
    const { storage: s, deleted } = storage([
      { name: "Screenshot 2026-10-25.png", type: "image/png", body: "png" },
      { name: "notes.txt", type: "text/plain", body: "hello" },
    ]);
    const files = await sharedFiles(s);
    // the bare type: bun's own File adds a charset to a text type, where a browser's keeps it as given
    expect(files.map((f) => [f.name, f.type.split(";")[0]])).toEqual([
      ["Screenshot 2026-10-25.png", "image/png"],
      ["notes.txt", "text/plain"],
    ]);
    expect(await files[1]!.text()).toBe("hello");
    expect(deleted).toEqual(["toyon-shared"]);
  });

  test("a page with no cache storage, or one that refuses, has nothing shared", async () => {
    expect(await sharedFiles(undefined)).toEqual([]);
    const refusing = {
      has: async () => {
        throw new DOMException("denied", "SecurityError");
      },
    } as unknown as CacheStorage;
    expect(await sharedFiles(refusing)).toEqual([]);
  });

  test("the worker and the page agree on the cache and the header", () => {
    // the worker is plain script and shares no module with the page: the names are held in both
    const worker = readFileSync(join(import.meta.dir, "../../public/sw.js"), "utf8");
    const page = readFileSync(join(import.meta.dir, "share.ts"), "utf8");
    for (const name of ['"toyon-shared"', '"x-toyon-name"', '"/share"']) {
      expect(worker).toContain(name);
      if (name !== '"/share"') expect(page).toContain(name);
    }
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "../../public/manifest.json"), "utf8"));
    expect(manifest.share_target).toMatchObject({ action: "/share", method: "POST", enctype: "multipart/form-data" });
    expect(manifest.share_target.params.files[0].name).toBe("files");
  });
});
