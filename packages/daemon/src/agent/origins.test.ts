import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandFolders, markOrigins, readCommandOrigins } from "./origins.ts";
import { BUILTIN_AGENTS } from "./registry.ts";

// The agent's list never says where a command came from; the folders it reads them from do.

const claude = BUILTIN_AGENTS.find((a) => a.id === "claude")!;
const codex = BUILTIN_AGENTS.find((a) => a.id === "codex")!;

function withDirs(fn: (home: string, project: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "toyon-origins-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  try {
    fn(home, project);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function skill(root: string, name: string, frontMatter = "") {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), `${frontMatter}# ${name}\n`);
}

function command(root: string, rel: string) {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), "do the thing\n");
}

describe("commandFolders", () => {
  test("claude reads the project's and the person's skills and commands, then each plugin folder from agents.json", () => {
    const spec = {
      ...claude,
      meta: { claudeCode: { options: { plugins: [{ type: "local", path: "/mods/tally" }] } } },
    };
    expect(commandFolders(spec, "/repo", "/home/me")).toEqual([
      { origin: "project", skills: "/repo/.claude/skills", commands: "/repo/.claude/commands" },
      { origin: "user", skills: "/home/me/.claude/skills", commands: "/home/me/.claude/commands" },
      { origin: "plugin", skills: "/mods/tally/skills", commands: "/mods/tally/commands" },
    ]);
  });

  test("a plugin entry that is not a local folder names none", () => {
    const spec = { ...claude, meta: { claudeCode: { options: { plugins: [{ type: "marketplace" }, "x", null] } } } };
    expect(commandFolders(spec, "/repo", "/home/me")).toHaveLength(2);
  });

  test("codex reads the person's prompts; a custom agent names nothing", () => {
    expect(commandFolders(codex, "/repo", "/home/me")).toEqual([
      { origin: "user", commands: "/home/me/.codex/prompts" },
    ]);
    expect(commandFolders({ ...claude, id: "mine" }, "/repo", "/home/me")).toEqual([]);
  });
});

describe("readCommandOrigins", () => {
  test("a skill is its folder's name, a command its file's, a namespaced command its file's alone", () =>
    withDirs((home, project) => {
      skill(join(project, ".claude", "skills"), "aws");
      command(join(project, ".claude", "commands"), "standup.md");
      command(join(project, ".claude", "commands"), "ops/deploy.md");
      command(join(home, ".claude", "commands"), "notes.txt");
      const origins = readCommandOrigins(commandFolders(claude, project, home));
      expect([...origins].sort()).toEqual([
        ["aws", "project"],
        ["deploy", "project"],
        ["standup", "project"],
      ]);
    }));

  test("front matter renames a skill; a folder without SKILL.md is not one", () =>
    withDirs((home) => {
      const skills = join(home, ".claude", "skills");
      skill(skills, "release-notes", "---\nname: toyon-release-notes\ndescription: draft them\n---\n");
      mkdirSync(join(skills, "scratch"), { recursive: true });
      expect([...readCommandOrigins(commandFolders(claude, "/nowhere", home))]).toEqual([
        ["toyon-release-notes", "user"],
      ]);
    }));

  test("the project's name shadows the person's, and a plugin folder is its own origin", () =>
    withDirs((home, project) => {
      skill(join(project, ".claude", "skills"), "review");
      skill(join(home, ".claude", "skills"), "review");
      const mod = join(home, "mods", "tally");
      skill(join(mod, "skills"), "tally-help");
      const spec = { ...claude, meta: { claudeCode: { options: { plugins: [{ type: "local", path: mod }] } } } };
      const origins = readCommandOrigins(commandFolders(spec, project, home));
      expect(origins.get("review")).toBe("project");
      expect(origins.get("tally-help")).toBe("plugin");
    }));

  test("folders that do not exist read as nothing", () => {
    expect(readCommandOrigins(commandFolders(claude, "/nowhere", "/nobody")).size).toBe(0);
  });
});

describe("markOrigins", () => {
  test("marks the names found and leaves the rest, and the agent's own list, untouched", () => {
    const cmds = [
      { name: "aws", description: "debug the envs" },
      { name: "compact", description: "free up context" },
    ];
    const marked = markOrigins(cmds, new Map([["aws", "project"]]));
    expect(marked).toEqual([
      { name: "aws", description: "debug the envs", origin: "project" },
      { name: "compact", description: "free up context" },
    ]);
    expect(cmds[0]).not.toHaveProperty("origin");
    expect(markOrigins(cmds, new Map())).toBe(cmds);
  });
});
