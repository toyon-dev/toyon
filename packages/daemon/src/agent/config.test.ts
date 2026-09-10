import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexServers, describeAgentConfig } from "./config.ts";
import { BUILTIN_AGENTS } from "./registry.ts";

// What settings shows about an agent's setup is read off the files the agent's own CLI writes.

const claude = BUILTIN_AGENTS.find((a) => a.id === "claude")!;
const codex = BUILTIN_AGENTS.find((a) => a.id === "codex")!;

function withHome(fn: (home: string, repo: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "toyon-agentcfg-"));
  const home = join(root, "home");
  const repo = join(root, "repo");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(repo, ".claude"), { recursive: true });
  try {
    fn(home, repo);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("describeAgentConfig", () => {
  test("claude: user, local and project servers, each with its scope, and the files whether or not they exist", () =>
    withHome((home, repo) => {
      writeFileSync(
        join(home, ".claude.json"),
        JSON.stringify({
          mcpServers: { github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] } },
          projects: { [repo]: { mcpServers: { db: { type: "http", url: "http://localhost:8787/mcp" } } } },
        }),
      );
      writeFileSync(
        join(repo, ".mcp.json"),
        JSON.stringify({ mcpServers: { design: { command: "bun", args: ["x"] } } }),
      );
      const info = describeAgentConfig(claude, repo, home);
      expect(info.servers).toEqual([
        { name: "github", scope: "user", detail: "npx -y @modelcontextprotocol/server-github" },
        { name: "db", scope: "local", detail: "http://localhost:8787/mcp" },
        { name: "design", scope: "project", detail: "bun x" },
      ]);
      expect(info.files.map((f) => [f.id, f.exists])).toEqual([
        ["user-config", true],
        ["user-settings", false],
        ["project-mcp", true],
        ["project-settings", false],
      ]);
    }));

  test("claude with no files at all is an empty list, not an error; a broken file is skipped", () =>
    withHome((home, repo) => {
      expect(describeAgentConfig(claude, null, home).servers).toEqual([]);
      writeFileSync(join(home, ".claude.json"), "{ nope");
      expect(describeAgentConfig(claude, repo, home).servers).toEqual([]);
    }));

  test("codex: mcp_servers tables from config.toml", () =>
    withHome((home) => {
      writeFileSync(
        join(home, ".codex", "config.toml"),
        [
          'model = "gpt-5"',
          "",
          "[mcp_servers.github]",
          'command = "npx"',
          'args = ["-y", "@modelcontextprotocol/server-github"]',
          "",
          '[mcp_servers."my server"]',
          'url = "https://example.test/mcp"',
          "",
          "[sandbox]",
          'command = "not a server"',
        ].join("\n"),
      );
      expect(codexServers(join(home, ".codex", "config.toml"))).toEqual([
        { name: "github", scope: "user", detail: "npx -y @modelcontextprotocol/server-github" },
        { name: "my server", scope: "user", detail: "https://example.test/mcp" },
      ]);
      expect(describeAgentConfig(codex, null, home).files.map((f) => f.exists)).toEqual([true]);
    }));
});
