import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Helper, type HelperSpec, helperFiles, helperWanted } from "./helper.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "toyon-helper-"));
  writeFileSync(join(dir, "helper-stub"), "stub v1");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const spec = (over: Partial<HelperSpec> = {}): HelperSpec => ({
  dir: join(dir, "Toyon.app"),
  stub: join(dir, "helper-stub"),
  bun: "/opt/bun",
  cli: "/pkg/cli.js",
  log: join(dir, "launcher.log"),
  // no file there: the icon is best effort and the test wants none drawn
  icon: join(dir, "icon.svg"),
  version: "1.2.3",
  ...over,
});

/** the tools the bundle is signed and registered with, faked and recorded */
function tools() {
  const ran: string[][] = [];
  const run = async (cmd: string[]) => {
    ran.push(cmd);
    return true;
  };
  const names = () => ran.map((c) => (c[0]?.endsWith("lsregister") ? "lsregister" : c[0]));
  return { ran, names, run };
}

const where = { platform: "darwin", cloud: false, port: 4141, home: undefined };

describe("helperWanted", () => {
  test("the default daemon on a Mac, and no other", () => {
    expect(helperWanted(where)).toBe(true);
    expect(helperWanted({ ...where, platform: "linux" })).toBe(false);
    expect(helperWanted({ ...where, cloud: true })).toBe(false);
    expect(helperWanted({ ...where, port: 4242 })).toBe(false);
    expect(helperWanted({ ...where, home: "/elsewhere" })).toBe(false);
  });
});

describe("helperFiles", () => {
  test("a hidden bundle that owns the scheme and takes any file", () => {
    const { plist } = helperFiles(spec(), "abc");
    expect(plist).toContain("<key>LSUIElement</key><true/>");
    expect(plist).toContain("<string>toyon</string>");
    expect(plist).toContain("<string>public.item</string>");
    expect(plist).toContain("<string>1.2.3</string>");
  });

  test("the script only finds bun and the CLI and hands over", () => {
    const { script } = helperFiles(spec(), "abc");
    expect(script).toContain("stub abc");
    // the bun it was written with first, then the places an upgrade moves it to, then PATH
    expect(script).toContain('for CAND in "/opt/bun" "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun');
    expect(script).toContain('BUN="$(command -v bun 2>/dev/null)"');
    expect(script).toContain('exec "$BUN" "$CLI" helper "$@"');
    expect(script).toContain('exec toyon helper "$@"');
  });

  /** a CLI that records what it was asked, standing where the real one goes */
  const fakeCli = () => {
    const calls = join(dir, "calls");
    const cli = join(dir, "cli.js");
    writeFileSync(
      cli,
      `require("fs").appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join("|") + "\\n");`,
    );
    return { cli, calls };
  };
  const runScript = async (s: HelperSpec, ...args: string[]) => {
    const file = join(dir, "launch.sh");
    writeFileSync(file, helperFiles(s, "abc").script, { mode: 0o755 });
    await Bun.spawn(["bash", file, ...args], { stdout: "ignore", stderr: "ignore" }).exited;
  };

  test("run by bash: the arguments reach the CLI's helper verb whole", async () => {
    const { cli, calls } = fakeCli();
    await runScript(spec({ bun: process.execPath, cli }), "file:///tmp/a%20b.txt", "/tmp/c d");
    expect(readFileSync(calls, "utf8")).toBe("helper|file:///tmp/a%20b.txt|/tmp/c d\n");
  });

  test("run by bash: a bun that moved is looked for again", async () => {
    const { cli, calls } = fakeCli();
    await runScript(spec({ bun: "/nowhere/bun", cli }), "toyon://start");
    expect(readFileSync(calls, "utf8")).toBe("helper|toyon://start\n");
  });
});

describe("Helper", () => {
  test("writes, signs and registers the bundle, then keeps it while nothing changed", async () => {
    const { ran, names, run } = tools();
    const helper = new Helper(spec(), run);
    expect(helper.startLink()).toBeNull();
    expect(await helper.ensure()).toBe("written");
    expect(helper.startLink()).toBe("toyon://start");
    const app = join(dir, "Toyon.app");
    expect(readFileSync(join(app, "Contents", "MacOS", "Toyon"), "utf8")).toBe("stub v1");
    expect(readFileSync(join(app, "Contents", "Info.plist"), "utf8")).toContain("dev.toyon.helper");
    expect(names()).toEqual(["qlmanage", "xattr", "codesign", "lsregister"]);

    ran.length = 0;
    expect(await helper.ensure()).toBe("kept");
    expect(ran).toEqual([]);
  });

  test("a changed CLI path, version or stub writes it again", async () => {
    const { run } = tools();
    await new Helper(spec(), run).ensure();
    expect(await new Helper(spec({ cli: "/elsewhere/cli.js" }), run).ensure()).toBe("written");
    const app = join(dir, "Toyon.app");
    expect(readFileSync(join(app, "Contents", "Resources", "launch.sh"), "utf8")).toContain("/elsewhere/cli.js");
    expect(await new Helper(spec({ cli: "/elsewhere/cli.js", version: "1.2.4" }), run).ensure()).toBe("written");
    writeFileSync(join(dir, "helper-stub"), "stub v2");
    expect(await new Helper(spec({ cli: "/elsewhere/cli.js", version: "1.2.4" }), run).ensure()).toBe("written");
    expect(readFileSync(join(app, "Contents", "MacOS", "Toyon"), "utf8")).toBe("stub v2");
  });

  test("no built stub, no bundle and no link", async () => {
    const { ran, run } = tools();
    const helper = new Helper(spec({ stub: join(dir, "missing") }), run);
    expect(await helper.ensure()).toBe("skipped");
    expect(helper.startLink()).toBeNull();
    expect(existsSync(join(dir, "Toyon.app"))).toBe(false);
    expect(ran).toEqual([]);
  });
});
