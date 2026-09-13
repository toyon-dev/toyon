import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BWRAP_APPARMOR_PROFILE,
  bwrapBlockedAdvice,
  bwrapStartError,
  missingSandboxTools,
  sandboxAdvice,
  userNamespacesRestricted,
} from "./sandboxDeps.ts";

describe("missingSandboxTools", () => {
  test("nothing is missing off Linux, whatever PATH holds", () => {
    expect(missingSandboxTools("", "darwin")).toEqual([]);
  });

  test("on Linux, names what PATH does not have", () => {
    const bin = mkdtempSync(join(tmpdir(), "toyon-sandbox-"));
    try {
      expect(missingSandboxTools(bin, "linux")).toEqual(["bwrap", "socat"]);
      writeFileSync(join(bin, "bwrap"), "#!/bin/sh\n");
      chmodSync(join(bin, "bwrap"), 0o755);
      expect(missingSandboxTools(bin, "linux")).toEqual(["socat"]);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  test("the advice names the missing tools and the apt line", () => {
    expect(sandboxAdvice(["bwrap"])).toBe(
      "Claude Code's sandbox on Linux needs bwrap; install with: sudo apt install bubblewrap socat",
    );
  });
});

// Ubuntu 24.04 ships bubblewrap and then refuses the user namespace it needs, so a bwrap on PATH
// that cannot start has to be named as well as a missing one.
describe("a bubblewrap that cannot start", () => {
  const fake = (script: string) => {
    const dir = mkdtempSync(join(tmpdir(), "toyon-bwrap-"));
    const exe = join(dir, "bwrap");
    writeFileSync(exe, `#!/bin/sh\n${script}\n`);
    chmodSync(exe, 0o755);
    return { exe, done: () => rmSync(dir, { recursive: true, force: true }) };
  };

  test("its own error is what is reported, and a working one reports nothing", () => {
    const refused = fake('echo "bwrap: setting up uid map: Permission denied" >&2; exit 1');
    const works = fake("exit 0");
    try {
      expect(bwrapStartError(refused.exe)).toBe("bwrap: setting up uid map: Permission denied");
      expect(bwrapStartError(works.exe)).toBeNull();
      expect(bwrapStartError(null)).toBeNull();
    } finally {
      refused.done();
      works.done();
    }
  });

  test("the restriction is read from the kernel setting, and its absence is no restriction", () => {
    expect(userNamespacesRestricted(() => "1\n")).toBe(true);
    expect(userNamespacesRestricted(() => "0\n")).toBe(false);
    expect(
      userNamespacesRestricted(() => {
        throw new Error("ENOENT");
      }),
    ).toBe(false);
  });

  test("under the restriction the advice carries the profile and the command that loads it", () => {
    const advice = bwrapBlockedAdvice("bwrap: setting up uid map: Permission denied", true);
    expect(advice).toContain("setting up uid map");
    expect(advice).toContain("sudo tee /etc/apparmor.d/bwrap");
    for (const l of BWRAP_APPARMOR_PROFILE.trimEnd().split("\n")) expect(advice).toContain(l);
    expect(advice).toContain("sudo apparmor_parser -r /etc/apparmor.d/bwrap");
    expect(bwrapBlockedAdvice("some other failure", false)).toBe(
      "bubblewrap is installed but cannot start a sandbox: some other failure",
    );
  });
});
