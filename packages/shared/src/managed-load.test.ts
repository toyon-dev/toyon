import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MANAGED_STRICTEST } from "./managed.ts";
import { loadManaged } from "./managed-load.ts";

// The loader decides what reaches the resolver: a file's ownership, and whether a plist could be
// read at all. A tmp dir is the person's, which is the case the ownership rule exists for.

describe("loadManaged", () => {
  const dir = mkdtempSync(join(tmpdir(), "toyon-managed-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "policy.json");
  const plist = join(dir, "dev.toyon.plist");

  test("an absent file is absent, and no plist reader runs for a plist that is not there", async () => {
    let asked = 0;
    const r = await loadManaged({
      sources: [
        { path: plist, kind: "plist" },
        { path: file, kind: "json" },
      ],
      plist: async () => {
        asked++;
        return "{}";
      },
    });
    expect(r.sources.map((s) => s.state)).toEqual(["absent", "absent"]);
    expect(r.problem).toBeNull();
    expect(asked).toBe(0);
  });

  // as root every file is root's, and the rule has nothing to refuse
  test.skipIf(process.getuid?.() === 0)("a JSON file the person owns is no policy: it fails closed", async () => {
    writeFileSync(file, '{ "updates": true }');
    const r = await loadManaged({ sources: [{ path: file, kind: "json" }] });
    expect(r.policy).toEqual(MANAGED_STRICTEST);
    expect(r.problem).toContain("not owned by root");
  });

  test("a plist is read through the reader, and a reader that fails is an invalid source", async () => {
    writeFileSync(plist, "<plist/>");
    const ok = await loadManaged({
      sources: [{ path: plist, kind: "plist" }],
      plist: async () => '{ "deploy": false }',
    });
    expect(ok.policy.deploy).toBe(false);
    expect(ok.source).toBe(plist);
    const bad = await loadManaged({
      sources: [{ path: plist, kind: "plist" }],
      plist: async () => {
        throw new Error("Property List error: Unexpected character");
      },
    });
    expect(bad.policy).toEqual(MANAGED_STRICTEST);
    expect(bad.problem).toContain("Unexpected character");
  });
});
