import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserError } from "../core/errors.ts";
import { bwrapArgs, confine, seatbeltProfile } from "./confine.ts";
import type { Bounds } from "./sandbox.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "toyon-confine-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const inside = join(base, "wt");
const outside = join(base, "outside");
const settings = join(inside, ".claude");
const secret = join(base, "home", "token");
mkdirSync(settings, { recursive: true });
mkdirSync(outside);
mkdirSync(join(base, "home"));
writeFileSync(secret, "hunter2");

// explicit bounds, with no temp directory in them: `outside` sits under $TMPDIR, and the real run
// below has to show a write there refused
const bounds: Bounds = { root: inside, allowWrite: [inside], denyWrite: [settings], denyRead: [secret], gitDir: null };
const launch = { command: "/bin/sh", args: ["-c", "true"], env: { A: "1" } };

describe("seatbeltProfile", () => {
  test("every write is denied, the bounds and the agent's own state allowed back, and the denials come after", () => {
    const lines = seatbeltProfile(bounds, ["/Users/x/.local/share/agent"]).split("\n");
    expect(lines.slice(0, 3)).toEqual(["(version 1)", "(allow default)", "(deny file-write*)"]);
    expect(lines[3]).toContain(`(subpath "${inside}")`);
    expect(lines[3]).toContain('(subpath "/Users/x/.local/share/agent")');
    expect(lines[4]).toBe(`(deny file-write* (subpath "${settings}"))`);
    expect(lines[5]).toBe(`(deny file-read* (subpath "${secret}"))`);
  });
  test("a quote or a backslash in a path cannot end the string early", () => {
    const odd = seatbeltProfile({ ...bounds, allowWrite: ['/w/a"b\\c'], denyWrite: [], denyRead: [] });
    expect(odd).toContain('(subpath "/w/a\\"b\\\\c")');
  });
});

describe("bwrapArgs", () => {
  test("the bounds bound writable, settings read-only, a secret file masked; what is missing is skipped", () => {
    const kinds: Record<string, "file" | "dir"> = { [inside]: "dir", [settings]: "dir", [secret]: "file" };
    expect(bwrapArgs(bounds, ["/missing"], (p) => kinds[p] ?? null)).toEqual([
      "--die-with-parent",
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--bind",
      inside,
      inside,
      "--ro-bind",
      settings,
      settings,
      "--ro-bind",
      "/dev/null",
      secret,
    ]);
  });
  test("a secret that is a directory is hidden under an empty one", () => {
    const args = bwrapArgs({ ...bounds, allowWrite: [], denyWrite: [], denyRead: ["/s"] }, [], () => "dir");
    expect(args.slice(-2)).toEqual(["--tmpfs", "/s"]);
  });
});

describe("confine", () => {
  test("macOS runs the command under sandbox-exec, Linux under bwrap; the environment is the launch's", () => {
    const mac = confine(launch, bounds, [], "darwin");
    expect(mac.command).toBe("/usr/bin/sandbox-exec");
    expect(mac.args.slice(2)).toEqual(["/bin/sh", "-c", "true"]);
    expect(mac.env).toEqual({ A: "1" });
    const linux = confine(launch, bounds, [], "linux", () => "/usr/bin/bwrap");
    expect(linux.command).toBe("/usr/bin/bwrap");
    expect(linux.args.slice(-4)).toEqual(["--", "/bin/sh", "-c", "true"]);
  });
  test("with no sandbox to run in, the agent does not start", () => {
    expect(() => confine(launch, bounds, [], "linux", () => null)).toThrow(UserError);
    expect(() => confine(launch, bounds, [], "win32")).toThrow(UserError);
  });
});

/** whether this machine can run the sandbox at all. It cannot where bwrap is missing, where user
 * namespaces are blocked (some CI runners), or inside a sandbox that forbids nesting another; the
 * real run is then reported skipped rather than passed. */
function canSandbox(): boolean {
  try {
    const l = confine({ command: "/bin/sh", args: ["-c", "true"], env: {} }, bounds);
    return Bun.spawnSync([l.command, ...l.args]).exitCode === 0;
  } catch {
    return false; // no sandbox on this platform: the same answer as one that cannot start
  }
}

describe.skipIf(!canSandbox())("confine, for real", () => {
  test("a write inside lands; a write outside and a read of a secret are refused", () => {
    const script = [
      `echo x > "${join(inside, "a")}"`,
      `echo x > "${join(outside, "a")}" 2>/dev/null`,
      `echo x > "${join(settings, "settings.local.json")}" 2>/dev/null`,
      `cat "${secret}" 2>/dev/null`,
      "true",
    ].join("; ");
    const l = confine({ command: "/bin/sh", args: ["-c", script], env: {} }, bounds);
    const r = Bun.spawnSync([l.command, ...l.args]);
    expect(existsSync(join(inside, "a"))).toBe(true);
    expect(existsSync(join(outside, "a"))).toBe(false);
    expect(existsSync(join(settings, "settings.local.json"))).toBe(false);
    expect(r.stdout.toString()).not.toContain("hunter2");
  });
});
