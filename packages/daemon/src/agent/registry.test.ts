import { describe, expect, test } from "bun:test";
import { UserError } from "../core/errors.ts";
import { AgentRegistry, BUILTIN_AGENTS, parseCustomAgents, resolveNpmBin } from "./registry.ts";

describe("agent registry", () => {
  test("both builtin adapters resolve to a script and launch under the current runtime", () => {
    const reg = new AgentRegistry(BUILTIN_AGENTS);
    for (const id of ["claude", "codex"]) {
      const spec = reg.require(id);
      const l = reg.launch(spec);
      expect(l.command).toBe(process.execPath);
      expect(l.args[0]).toMatch(/dist\/index\.js$/);
    }
    expect(reg.infos().map((i) => [i.id, i.available, i.sandboxed])).toEqual([
      ["claude", true, true],
      ["codex", true, true],
    ]);
    expect(resolveNpmBin("@toyon/nope", "x")).toBeNull();
  });

  test("unknown and uninstalled agents are UserErrors with a reason", () => {
    const reg = new AgentRegistry([
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
    ]);
    expect(() => reg.require("nope")).toThrow(UserError);
    expect(() => reg.require("ghost")).toThrow(/not installed/);
    const ghost = reg.infos().find((i) => i.id === "ghost")!;
    expect(ghost.available).toBe(false);
    expect(ghost.reason).toContain("not found on PATH");
    expect(ghost.sandboxed).toBe(false);
  });

  test("custom agents: valid entries are kept, invalid ones skipped, builtins can be shadowed", () => {
    const specs = parseCustomAgents(
      JSON.stringify({
        gemini: { name: "Gemini CLI", command: "gemini", args: ["--experimental-acp"], env: { A: "1" } },
        "Bad Id": { command: "x" },
        nocmd: { name: "no command" },
        badargs: { command: "x", args: "nope" },
        badconf: { command: "x", confinement: "claude-settings" },
        claude: { command: "my-claude-acp", confinement: "adapter-sandbox", mode: "agent" },
      }),
    );
    expect(specs.map((s) => s.id)).toEqual(["gemini", "claude"]);
    expect(specs[0]).toMatchObject({
      name: "Gemini CLI",
      run: { kind: "command", command: "gemini", args: ["--experimental-acp"] },
      env: { A: "1" },
      confinement: "none",
      systemPrompt: "prompt-prefix",
    });
    expect(specs[1]).toMatchObject({ confinement: "adapter-sandbox", mode: "agent" });
    const reg = new AgentRegistry([...BUILTIN_AGENTS, ...specs]);
    expect(reg.get("claude")?.builtin).toBe(false);
    expect(parseCustomAgents("not json")).toEqual([]);
    expect(parseCustomAgents("[]")).toEqual([]);
  });
});
