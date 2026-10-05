import { describe, expect, test } from "bun:test";
import type { RepoInfo } from "@toyon/shared";
import { setupFixPrompt } from "./fixPrompt.ts";

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
