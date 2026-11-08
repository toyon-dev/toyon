import { describe, expect, test } from "bun:test";
import type { RepoInfo } from "@toyon/shared";
import { keepApartPrompt, setupFixPrompt } from "./fixPrompt.ts";

// The two prompts the panes send on a click: what the agent is told has to carry the diagnosis
// and the one rule the fix must satisfy, since that is all it gets.

describe("setupFixPrompt", () => {
  test("asks for the file a save would write, in the shape the daemon reads", () => {
    const repo: RepoInfo = {
      id: "r",
      name: "shop",
      path: "/p",
      defaultBranch: "main",
      config: { run: {} },
      configFile: ".toyon/settings.local.json",
      needsSetup: true,
    };
    const text = setupFixPrompt(repo, repo.configFile);
    expect(text).toContain("shop");
    expect(text).toContain("write `.toyon/settings.local.json`");
    // the pane's chip can send the agent to the other file of the pair
    expect(setupFixPrompt(repo, ".toyon/settings.json")).toContain("write `.toyon/settings.json`");
    expect(text).toContain('"run": { "web": "<start command>" }');
    expect(text).toContain("Do not start any server yourself");
    // a fresh worktree lacks the main checkout's gitignored caches; the agent has to be told
    // where to copy them from, or it never writes the line
    expect(text).toContain("$TOYON_ROOT");
  });
});

describe("keepApartPrompt", () => {
  const repo: RepoInfo = {
    id: "r",
    name: "shop",
    path: "/p",
    defaultBranch: "main",
    config: { run: { web: "w", api: "a" } },
    configFile: ".toyon/settings.json",
    needsSetup: false,
  };
  test("puts the recipe under the shared command's own setup and teardown", () => {
    const text = keepApartPrompt(repo, repo.configFile, { envUrl: { name: "DATABASE_URL", file: ".env" } }, ["api"]);
    expect(text).toContain("shop");
    expect(text).toContain("`DATABASE_URL` in `.env`");
    expect(text).toContain("the shared command `api` carries the recipe");
    expect(text).toContain('"api": { "cmd": "<its command>", "setup": ["uv sync", "createdb -T app_template');
    expect(text).toContain('{ "cmd": "docker compose up db", "paths": [] }');
    // the shell idiom, not a template hole
    expect(text).toContain("${TOYON_WORKTREE:+_$TOYON_WORKTREE}");
    expect(text).toContain("the top-level `setup` is for the page");
    expect(text).not.toContain("profile");
    expect(text).not.toContain('"from": "trunk"');
  });
  test("with nothing shared it names the command that serves the database", () => {
    const text = keepApartPrompt(repo, repo.configFile, { compose: "compose.yaml" }, []);
    expect(text).toContain("the compose stack in `compose.yaml`");
    expect(text).toContain("the command that serves the database carries the recipe");
    expect(text).toContain('"api": { "cmd"');
  });
});
