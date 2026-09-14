import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locateAssets, pruneAssets } from "./assets.ts";

const DAY = 24 * 60 * 60 * 1000;

// The daemon finds its shell in the tree and in the package by what sits next to it, so the
// bundle needs no build-time path baked in.

describe("locateAssets", () => {
  test("a shell directory beside the entry means the package layout", () => {
    const here = mkdtempSync(join(tmpdir(), "toyon-assets-"));
    try {
      mkdirSync(join(here, "shell"));
      writeFileSync(join(here, "shell", "index.html"), "");
      const a = locateAssets(here, {});
      expect(a.shellDist).toBe(join(here, "shell"));
      expect(a.bridgeJs).toBe(join(here, "bridge.js"));
      // the package ships its bundles; there is no checkout behind it to fall behind
      expect(a.sourceRoot).toBeNull();
    } finally {
      rmSync(here, { recursive: true, force: true });
    }
  });
  test("otherwise the source tree, two packages over", () => {
    const a = locateAssets("/src/packages/daemon/src", {});
    expect(a.shellDist).toBe("/src/packages/shell/dist");
    expect(a.bridgeJs).toBe("/src/packages/bridge/dist/bridge.js");
    expect(a.sourceRoot).toBe("/src");
  });
  test("the environment wins over both", () => {
    const a = locateAssets("/x", { TOYON_SHELL_DIST: "/elsewhere/shell", TOYON_BRIDGE_JS: "/elsewhere/b.js" });
    // the overrides move the bundles, not the tree: a nested daemon is still running from one
    expect(a).toEqual({ shellDist: "/elsewhere/shell", bridgeJs: "/elsewhere/b.js", sourceRoot: "/" });
  });
});

describe("pruneAssets", () => {
  const build = (dir: string, names: string[], mtime: number) => {
    for (const name of names) {
      const path = join(dir, "assets", name);
      writeFileSync(path, name);
      utimesSync(path, mtime / 1000, mtime / 1000);
    }
  };

  test("keeps the newest build and anything recent behind it", () => {
    const dist = mkdtempSync(join(tmpdir(), "toyon-prune-"));
    try {
      mkdirSync(join(dist, "assets"));
      const now = Date.now();
      build(dist, ["old-aaa.js"], now - 30 * DAY);
      build(dist, ["yesterday-bbb.js"], now - DAY);
      build(dist, ["index-ccc.js", "index-ddd.css"], now);
      expect(pruneAssets(dist)).toBe(1);
      expect(readdirSync(join(dist, "assets")).sort()).toEqual(["index-ccc.js", "index-ddd.css", "yesterday-bbb.js"]);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  test("a lone build is never the one thrown away, however old", () => {
    const dist = mkdtempSync(join(tmpdir(), "toyon-prune-"));
    try {
      mkdirSync(join(dist, "assets"));
      build(dist, ["index-aaa.js"], Date.now() - 200 * DAY);
      expect(pruneAssets(dist)).toBe(0);
      expect(readdirSync(join(dist, "assets"))).toEqual(["index-aaa.js"]);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  test("nothing built yet is not an error", () => {
    const dist = mkdtempSync(join(tmpdir(), "toyon-prune-"));
    try {
      expect(pruneAssets(dist)).toBe(0);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });
});
