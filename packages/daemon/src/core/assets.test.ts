import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locateAssets } from "./assets.ts";

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
    } finally {
      rmSync(here, { recursive: true, force: true });
    }
  });
  test("otherwise the source tree, two packages over", () => {
    const a = locateAssets("/src/packages/daemon/src", {});
    expect(a.shellDist).toBe("/src/packages/shell/dist");
    expect(a.bridgeJs).toBe("/src/packages/bridge/dist/bridge.js");
  });
  test("the environment wins over both", () => {
    const a = locateAssets("/x", { TOYON_SHELL_DIST: "/elsewhere/shell", TOYON_BRIDGE_JS: "/elsewhere/b.js" });
    expect(a).toEqual({ shellDist: "/elsewhere/shell", bridgeJs: "/elsewhere/b.js" });
  });
});
