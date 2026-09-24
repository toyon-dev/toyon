import { describe, expect, test } from "bun:test";
import type { RepoInfo, WorktreeStatus } from "@toyon/shared";
import { procFixPrompt, setupFixPrompt } from "./fixPrompt.ts";

// The two prompts the panes send on a click: what the agent is told has to carry the diagnosis
// and the one rule the fix must satisfy, since that is all it gets.

const wt = (procs: WorktreeStatus["procs"]): WorktreeStatus =>
  ({ id: "w1", repoId: "r", path: "/w", name: "w1", branch: "b", procs, agent: "idle" }) as WorktreeStatus;

describe("procFixPrompt", () => {
  test("names the bad procs with their command, port and diagnosis, and the output tail", () => {
    const text = procFixPrompt(
      wt([
        {
          name: "web",
          command: "npm run dev",
          port: 4523,
          status: "unreachable",
          detail: "nothing listening on :4523",
        },
        { name: "api", command: "bun api", port: 4524, status: "running" },
      ]),
      [
        { proc: "web", line: "VITE ready" },
        { proc: "web", line: "Local: http://localhost:5173/" },
      ],
    );
    expect(text).toContain("`web`: `npm run dev`, started with PORT=4523. nothing listening on :4523");
    expect(text).not.toContain("`api`");
    expect(text).toContain("[web] Local: http://localhost:5173/");
    expect(text).toContain("PORT environment variable");
  });
  test("a crash without a diagnosis says the exit code; no output says so", () => {
    const text = procFixPrompt(wt([{ name: "web", command: "x", port: 1, status: "crashed", exitCode: 2 }]), []);
    expect(text).toContain("exited with code 2");
    expect(text).toContain("It produced no output.");
  });
});

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
