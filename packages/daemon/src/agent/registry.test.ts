import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { UserError } from "../core/errors.ts";
import { AgentRegistry, type AgentSpec, BUILTIN_AGENTS, type Installer, parseCustomAgents } from "./registry.ts";
import type { Prepared } from "./sandbox.ts";

const prepared: Prepared = {
  bounds: { root: "/w", allowWrite: ["/w"], denyWrite: [], denyRead: [], gitDir: null },
  env: { FROM_SETUP: "1" },
};

/** an installer that "downloads" by writing the package's bin into place; a rejected pkg fails */
function fakeInstaller(fail = new Set<string>()): { installer: Installer; calls: string[] } {
  const calls: string[] = [];
  const installer: Installer = async (dir, pkg, version) => {
    calls.push(`${pkg}@${version}`);
    if (fail.has(pkg)) return { ok: false, err: "registry unreachable" };
    const pkgDir = join(dir, "node_modules", pkg);
    mkdirSync(join(pkgDir, "dist"), { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ version, bin: { [pkg.split("/")[1]!]: "dist/index.js" } }),
    );
    writeFileSync(join(pkgDir, "dist", "index.js"), "");
    return { ok: true, err: "" };
  };
  return { installer, calls };
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "toyon-registry-"));
  dirs.push(dir);
  return dir;
}

describe("agent registry", () => {
  test("builtins start uninstalled; installMissing fetches them in order and they become launchable", async () => {
    const { installer, calls } = fakeInstaller();
    const reg = new AgentRegistry(BUILTIN_AGENTS, tmp(), installer);
    const changes: string[][] = [];
    reg.onChange = () =>
      changes.push(reg.infos().map((i) => `${i.id}:${i.installing ? "installing" : i.available ? "ok" : i.reason}`));
    expect(reg.infos().map((i) => [i.id, i.available, i.reason])).toEqual([
      ["claude", false, "not installed yet"],
      ["codex", false, "not installed yet"],
    ]);
    expect(() => reg.require("claude")).toThrow(/not ready/);
    await reg.installMissing();
    expect(calls).toEqual(["@agentclientprotocol/claude-agent-acp@0.75.1", "@agentclientprotocol/codex-acp@1.10.0"]);
    expect(changes[0]).toEqual(["claude:installing", "codex:not installed yet"]);
    expect(changes.at(-1)).toEqual(["claude:ok", "codex:ok"]);
    const l = reg.launch(reg.require("claude"), prepared);
    expect(l.command).toBe(process.execPath);
    expect(l.env).toEqual({ FROM_SETUP: "1" });
    expect(l.args[0]).toMatch(/claude-agent-acp\/dist\/index\.js$/);
    expect(JSON.parse(readFileSync(join(l.args[0]!, "../../package.json"), "utf8")).version).toBe("0.75.1");
    // already at the pinned version: nothing to do
    await reg.installMissing();
    expect(calls).toHaveLength(2);
  });

  test("a failed install is remembered as the reason and can be retried; concurrent installs share one run", async () => {
    const fail = new Set(["@agentclientprotocol/codex-acp"]);
    const { installer, calls } = fakeInstaller(fail);
    const reg = new AgentRegistry(BUILTIN_AGENTS, tmp(), installer);
    await Promise.all([reg.install("codex"), reg.install("codex")]);
    expect(calls).toHaveLength(1);
    expect(reg.infos()[1]).toMatchObject({
      id: "codex",
      available: false,
      reason: "install failed: registry unreachable",
    });
    fail.clear();
    await reg.install("codex");
    expect(reg.infos()[1]).toMatchObject({ id: "codex", available: true });
  });

  test("unknown ids and uninstalled custom commands are UserErrors with a reason", () => {
    const reg = new AgentRegistry(
      [
        ...BUILTIN_AGENTS,
        {
          id: "ghost",
          name: "Ghost",
          builtin: false,
          run: { kind: "command", command: "definitely-not-a-binary-xyz" },
          confinement: "none",
          systemPrompt: "prompt-prefix",
          loginHint: "",
        },
      ],
      tmp(),
    );
    expect(() => reg.require("nope")).toThrow(UserError);
    expect(() => reg.require("ghost")).toThrow(/not found on PATH/);
    const ghost = reg.infos().find((i) => i.id === "ghost")!;
    expect(ghost).toMatchObject({ available: false, sandboxed: false });
  });

  test("custom agents: valid entries are kept, invalid ones skipped, builtins can be shadowed", () => {
    const specs = parseCustomAgents(
      JSON.stringify({
        gemini: {
          name: "Gemini CLI",
          command: "gemini",
          args: ["--experimental-acp"],
          env: { A: "1" },
          quickModel: "gemini-flash",
        },
        "Bad Id": { command: "x" },
        nocmd: { name: "no command" },
        badargs: { command: "x", args: "nope" },
        badconf: { command: "x", confinement: "claude-settings" },
        unknownconf: { command: "x", confinement: "jail" },
        boxed: { command: "x", confinement: "toyon-sandbox" },
        claude: { command: "my-claude-acp", confinement: "adapter-sandbox", mode: "agent" },
      }),
    );
    expect(specs.map((s) => s.id)).toEqual(["gemini", "boxed", "claude"]);
    expect(specs[1]).toMatchObject({ confinement: "toyon-sandbox" });
    specs.splice(1, 1);
    expect(specs[0]).toMatchObject({
      name: "Gemini CLI",
      run: { kind: "command", command: "gemini", args: ["--experimental-acp"] },
      env: { A: "1" },
      confinement: "none",
      systemPrompt: "prompt-prefix",
      quickModel: "gemini-flash",
    });
    expect(specs[1]).toMatchObject({ confinement: "adapter-sandbox", mode: "agent" });
    const reg = new AgentRegistry([...BUILTIN_AGENTS, ...specs], tmp());
    expect(reg.get("claude")?.builtin).toBe(false);
    expect(parseCustomAgents("not json")).toEqual([]);
    expect(parseCustomAgents("[]")).toEqual([]);
  });

  test("an agent in toyon's sandbox launches inside it; its own command line stays unwrapped for a login", () => {
    const boxed: AgentSpec = {
      id: "boxed",
      name: "Boxed",
      builtin: false,
      run: { kind: "command", command: "sh", args: ["-c", "true"] },
      confinement: "toyon-sandbox",
      stateDirs: [".local/share/boxed"],
      systemPrompt: "prompt-prefix",
      loginHint: "",
    };
    const reg = new AgentRegistry([boxed], tmp());
    expect(reg.command(boxed)).toEqual({ command: "sh", args: ["-c", "true"] });
    const launch = () => reg.launch(boxed, prepared);
    if (process.platform === "linux" && !Bun.which("bwrap")) {
      expect(launch).toThrow(UserError);
      return;
    }
    const l = launch();
    expect(l.command).not.toBe("sh");
    expect(l.args.slice(-3)).toEqual(["sh", "-c", "true"]);
    expect(l.env).toEqual({ FROM_SETUP: "1" });
    if (process.platform === "darwin") expect(l.args[1]).toContain(join(homedir(), ".local/share/boxed"));
  });
});
