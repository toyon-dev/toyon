import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { missingSandboxTools, sandboxAdvice } from "./sandboxDeps.ts";

describe("missingSandboxTools", () => {
  test("nothing is missing off Linux, whatever PATH holds", () => {
    expect(missingSandboxTools("", "darwin")).toEqual([]);
  });

  test("on Linux, names what PATH does not have", () => {
    const bin = mkdtempSync(join(tmpdir(), "toyon-sandbox-"));
    expect(missingSandboxTools(bin, "linux")).toEqual(["bwrap", "socat"]);
    writeFileSync(join(bin, "bwrap"), "#!/bin/sh\n");
    chmodSync(join(bin, "bwrap"), 0o755);
    expect(missingSandboxTools(bin, "linux")).toEqual(["socat"]);
  });

  test("the advice names the missing tools and the apt line", () => {
    expect(sandboxAdvice(["bwrap"])).toBe(
      "Claude Code's sandbox on Linux needs bwrap; install with: sudo apt install bubblewrap socat",
    );
  });
});
