import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { UserError } from "../core/errors.ts";
import {
  AgentRegistry,
  type AgentSpec,
  BUILTIN_AGENTS,
  type Installer,
  managedSpecs,
  parseAgentsFile,
} from "./registry.ts";
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
    // a native build: the binary at its bin path, no JS entry
    if (pkg.startsWith("opencode-")) {
      mkdirSync(join(pkgDir, "bin"), { recursive: true });
      writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ version }));
      writeFileSync(join(pkgDir, "bin", "opencode"), "");
      return { ok: true, err: "" };
    }
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

describe("claude's terminal login", () => {
  test("replaces a method of the adapter version it was read from", () => {
    const claude = BUILTIN_AGENTS.find((a) => a.id === "claude")!;
    // claude-agent-acp names its no-browser login `claude-login` and takes `--cli auth login`: a new
    // adapter version is checked for both before this pin moves
    expect(claude.run).toMatchObject({ pkg: "@agentclientprotocol/claude-agent-acp", version: "0.84.0" });
    // `plan` marks it as the consumer sign-in a managed policy can withhold
    expect(claude.terminalLogins).toEqual({
      "claude-login": { args: ["--cli", "auth", "login", "--claudeai"], env: { NO_BROWSER: "1" }, plan: true },
    });
  });
});

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
      ["opencode", false, "not installed"],
    ]);
    expect(() => reg.require("claude")).toThrow(/not ready/);
    await reg.installMissing();
    expect(calls).toEqual(["@agentclientprotocol/claude-agent-acp@0.84.0", "@agentclientprotocol/codex-acp@2.0.1"]);
    expect(changes[0]).toEqual(["claude:installing", "codex:not installed yet", "opencode:not installed"]);
    expect(changes.at(-1)).toEqual(["claude:ok", "codex:ok", "opencode:not installed"]);
    const l = reg.launch(reg.require("claude"), prepared);
    expect(l.command).toBe(process.execPath);
    expect(l.env).toEqual({ CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: "1", FROM_SETUP: "1" });
    expect(l.args[0]).toMatch(/claude-agent-acp\/dist\/index\.js$/);
    expect(JSON.parse(readFileSync(join(l.args[0]!, "../../package.json"), "utf8")).version).toBe("0.84.0");
    // already at the pinned version: nothing to do
    await reg.installMissing();
    expect(calls).toHaveLength(2);
  });

  test("OpenCode waits to be asked for, then installs as this machine's native build and runs as that binary", async () => {
    const { installer, calls } = fakeInstaller();
    const host = { platform: "linux" as const, arch: "x64", musl: true, avx2: false };
    const reg = new AgentRegistry(BUILTIN_AGENTS, tmp(), installer, host);
    await reg.installMissing();
    expect(calls.some((c) => c.startsWith("opencode"))).toBe(false);
    expect(reg.infos().find((i) => i.id === "opencode")).toMatchObject({
      available: false,
      reason: "not installed",
      onDemand: true,
      sandboxed: true,
    });
    await reg.install("opencode");
    expect(calls.at(-1)).toBe("opencode-linux-x64-baseline-musl@1.18.33");
    const spec = reg.require("opencode");
    expect(reg.command(spec)).toEqual({
      command: expect.stringMatching(/opencode-linux-x64-baseline-musl\/bin\/opencode$/),
      args: ["acp"],
    });
    // already at the pinned version: asking again installs nothing
    await reg.install("opencode");
    expect(calls.filter((c) => c.startsWith("opencode"))).toHaveLength(1);
  });

  test("a native agent with no build for this machine says so instead of offering an install", () => {
    const reg = new AgentRegistry(BUILTIN_AGENTS, tmp(), fakeInstaller().installer, {
      platform: "freebsd",
      arch: "x64",
      musl: false,
      avx2: true,
    });
    expect(reg.infos().find((i) => i.id === "opencode")?.reason).toBe("no build for freebsd x64");
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

  test("a failed upgrade keeps the older adapter launchable, and adapters() says which version runs and why", async () => {
    const dir = tmp();
    const old = BUILTIN_AGENTS.map((a) => (a.id === "claude" ? { ...a, run: { ...a.run, version: "0.75.1" } } : a));
    await new AgentRegistry(old as AgentSpec[], dir, fakeInstaller().installer).installMissing();
    const reg = new AgentRegistry(
      BUILTIN_AGENTS,
      dir,
      fakeInstaller(new Set(["@agentclientprotocol/claude-agent-acp"])).installer,
    );
    await reg.installMissing();
    expect(reg.infos()[0]).toMatchObject({ id: "claude", available: true });
    // OpenCode is fetched on demand and nobody asked, so it is not listed
    expect(reg.adapters()).toEqual([
      { id: "claude", installed: "0.75.1", pinned: "0.84.0", error: "install failed: registry unreachable" },
      { id: "codex", installed: "2.0.1", pinned: "2.0.1" },
    ]);
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
    const specs = parseAgentsFile(
      JSON.stringify({
        gemini: {
          name: "Gemini CLI",
          command: "gemini",
          args: ["--experimental-acp"],
          env: { A: "1" },
          meta: { gemini: { tools: [] } },
          quickModel: "gemini-flash",
        },
        "Bad Id": { command: "x" },
        nocmd: { name: "no command" },
        badargs: { command: "x", args: "nope" },
        badmeta: { command: "x", meta: ["nope"] },
        badconf: { command: "x", confinement: "claude-settings" },
        unknownconf: { command: "x", confinement: "jail" },
        boxed: { command: "x", confinement: "toyon-sandbox" },
        claude: { command: "my-claude-acp", confinement: "adapter-sandbox", mode: "agent" },
      }),
      BUILTIN_AGENTS,
    );
    // a shadow takes the builtin's place, so the order the rail lists agents in does not move
    expect(specs.map((s) => s.id)).toEqual(["claude", "codex", "opencode", "gemini", "boxed"]);
    expect(specs[0]).toMatchObject({ builtin: false, confinement: "adapter-sandbox", mode: "agent" });
    expect(specs[3]).toMatchObject({
      name: "Gemini CLI",
      run: { kind: "command", command: "gemini", args: ["--experimental-acp"] },
      env: { A: "1" },
      meta: { gemini: { tools: [] } },
      confinement: "none",
      systemPrompt: "prompt-prefix",
      quickModel: "gemini-flash",
    });
    expect(specs[4]).toMatchObject({ confinement: "toyon-sandbox" });
    const reg = new AgentRegistry(specs, tmp());
    expect(reg.get("claude")?.builtin).toBe(false);
    expect(parseAgentsFile("not json", BUILTIN_AGENTS)).toEqual(BUILTIN_AGENTS);
    expect(parseAgentsFile("[]", BUILTIN_AGENTS)).toEqual(BUILTIN_AGENTS);
  });

  test("an entry under a builtin's id with no command tunes it: env over its own, meta on its sessions", () => {
    const specs = parseAgentsFile(
      JSON.stringify({
        claude: {
          env: { CLAUDE_CONFIG_DIR: "/home/me/.claude-work" },
          meta: { claudeCode: { options: { plugins: [{ type: "local", path: "/home/me/mods/sprint" }] } } },
        },
        codex: { env: { OPENAI_BASE_URL: "http://proxy" } },
        opencode: { meta: "nope" },
        gemini: { env: { A: "1" } },
      }),
      BUILTIN_AGENTS,
    );
    expect(specs.map((s) => s.id)).toEqual(["claude", "codex", "opencode"]);
    const claude = specs[0]!;
    expect(claude.builtin).toBe(true);
    expect(claude.run).toEqual(BUILTIN_AGENTS[0]!.run);
    expect(claude.env).toEqual({ ...BUILTIN_AGENTS[0]!.env, CLAUDE_CONFIG_DIR: "/home/me/.claude-work" });
    expect(claude.meta).toEqual({
      claudeCode: { options: { plugins: [{ type: "local", path: "/home/me/mods/sprint" }] } },
    });
    expect(claude.sideMeta).toEqual(BUILTIN_AGENTS[0]!.sideMeta);
    // the builtin's own env stays under the tuning
    expect(specs[1]!.env).toEqual({ ...BUILTIN_AGENTS[1]!.env, OPENAI_BASE_URL: "http://proxy" });
    expect(specs[2]).toBe(BUILTIN_AGENTS[2]);
    // the builtins themselves are left as they were
    expect(BUILTIN_AGENTS[0]!.meta).toBeUndefined();
    expect(BUILTIN_AGENTS[1]!.env).not.toHaveProperty("OPENAI_BASE_URL");
  });

  test("the managed policy: an allowlist drops a builtin, and custom agents off drops the file's entries, a shadowing one included", () => {
    const all = parseAgentsFile(
      JSON.stringify({ gemini: { command: "gemini" }, claude: { command: "my-claude" } }),
      BUILTIN_AGENTS,
    );
    const ids = (specs: AgentSpec[]) => specs.map((s) => s.id);
    expect(ids(managedSpecs(all, { agents: null, customAgents: true }))).toEqual(ids(all));
    expect(ids(managedSpecs(all, { agents: ["claude", "codex"], customAgents: true }))).toEqual(["claude", "codex"]);
    // an id nothing answers to is ignored rather than refused
    expect(ids(managedSpecs(all, { agents: ["codex", "nope"], customAgents: true }))).toEqual(["codex"]);
    const builtinsOnly = managedSpecs(all, { agents: null, customAgents: false });
    expect(builtinsOnly.every((s) => s.builtin)).toBe(true);
    expect(ids(builtinsOnly)).not.toContain("gemini");
    // the default follows what is left: the persisted choice while it exists, else claude, else the first
    const reg = new AgentRegistry(managedSpecs(all, { agents: ["codex", "opencode"], customAgents: false }), tmp());
    expect(reg.defaultId("codex")).toBe("codex");
    expect(reg.defaultId("claude")).toBe("codex");
    expect(reg.defaultId(undefined)).toBe("codex");
    // custom agents off: the file is never read, so the builtin stands where its shadow would have
    expect(
      new AgentRegistry(managedSpecs(BUILTIN_AGENTS, { agents: null, customAgents: false }), tmp()).defaultId("gemini"),
    ).toBe("claude");
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
