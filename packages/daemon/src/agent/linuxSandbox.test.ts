import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserError } from "../core/errors.ts";
import { LinuxSandbox, probeBwrap } from "./linuxSandbox.ts";
import { AgentRegistry, type AgentSpec } from "./registry.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function fakeBwrap(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "toyon-bwrap-"));
  dirs.push(dir);
  const exe = join(dir, "bwrap");
  writeFileSync(exe, `#!/bin/sh\n${script}\n`);
  chmodSync(exe, 0o755);
  return exe;
}

describe("probeBwrap", () => {
  test("a missing bubblewrap says what to install", async () => {
    expect(await probeBwrap(() => null)).toContain("sudo apt install bubblewrap socat");
  });

  test("one that is refused reports its own error and where the fix is", async () => {
    const exe = fakeBwrap('echo "bwrap: setting up uid map: Permission denied" >&2; exit 1');
    const why = await probeBwrap(() => exe);
    expect(why).toContain("setting up uid map: Permission denied");
    expect(why).toContain("toyon doctor");
  });

  test("one that starts is no problem", async () => {
    expect(await probeBwrap(() => fakeBwrap("exit 0"))).toBeNull();
  });
});

describe("LinuxSandbox", () => {
  test("off Linux there is nothing to check", async () => {
    let probes = 0;
    const s = new LinuxSandbox("darwin", async () => {
      probes++;
      return "never";
    });
    await s.refresh();
    expect(s.problem()).toBeNull();
    expect(probes).toBe(0);
  });

  test("a failure is kept for the retry window, then probed again, and a pass is kept for good", async () => {
    let clock = 0;
    let answer: string | null = "blocked";
    let probes = 0;
    const s = new LinuxSandbox(
      "linux",
      async () => {
        probes++;
        return answer;
      },
      () => clock,
      30_000,
    );
    await s.refresh();
    expect(s.problem()).toBe("blocked");
    expect(probes).toBe(1);

    clock = 10_000;
    expect(s.problem()).toBe("blocked");
    expect(probes).toBe(1);

    // fixed while toyon runs: the next read after the window probes in the background
    answer = null;
    clock = 30_000;
    expect(s.problem()).toBe("blocked");
    await Bun.sleep(0);
    await s.refresh();
    expect(s.problem()).toBeNull();

    const settled = probes;
    clock = 10_000_000;
    expect(s.problem()).toBeNull();
    expect(probes).toBe(settled);
  });
});

describe("the registry and a sandbox that cannot start", () => {
  const spec = (confinement: AgentSpec["confinement"]): AgentSpec => ({
    id: `sh-${confinement}`,
    name: "Shell",
    builtin: false,
    run: { kind: "command", command: "sh", args: [] },
    confinement,
    systemPrompt: "prompt-prefix",
    loginHint: "",
  });

  test("a confined agent is not ready, and says why", () => {
    const dir = mkdtempSync(join(tmpdir(), "toyon-registry-"));
    dirs.push(dir);
    const boxed = spec("toyon-sandbox");
    const reg = new AgentRegistry([boxed], dir, undefined, undefined, { problem: () => "bubblewrap cannot start" });
    expect(reg.unavailable(boxed)).toBe("bubblewrap cannot start");
    expect(() => reg.require(boxed.id)).toThrow(UserError);
    expect(() => reg.require(boxed.id)).toThrow("Shell is not ready: bubblewrap cannot start");
  });

  test("an unconfined agent does not depend on it", () => {
    const dir = mkdtempSync(join(tmpdir(), "toyon-registry-"));
    dirs.push(dir);
    const open = spec("none");
    const reg = new AgentRegistry([open], dir, undefined, undefined, { problem: () => "bubblewrap cannot start" });
    expect(reg.unavailable(open)).toBeNull();
  });
});
