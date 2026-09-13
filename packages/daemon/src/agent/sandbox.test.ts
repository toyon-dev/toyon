import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sh, tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { GIT } from "../git/exec.ts";
import { canonical, within } from "./bounds.ts";
import { claudeDenyRules } from "./commands.ts";
import type { AgentSpec } from "./registry.ts";
import {
  type Bounds,
  prepareLaunch,
  SETTINGS_REL,
  toyonSecrets,
  worktreeBounds,
  writeClaudeLocalSettings,
} from "./sandbox.ts";

let cleanup = () => {};
afterEach(() => cleanup());

function linkedWorktree() {
  const t = tmpRepo();
  cleanup = t.cleanup;
  const wt = join(t.repo, "..", "wt");
  sh(t.repo, GIT, "worktree", "add", "-q", "-b", "feat", wt, "main");
  return { ...t, wt };
}

describe("sandbox", () => {
  test("bounds of a linked worktree allow its root and the main repo's git dir, deny every agent's settings", async () => {
    const { repo, wt } = linkedWorktree();
    const b = await worktreeBounds(wt);
    expect(b.root).toBe(canonical(wt));
    expect(b.gitDir).toBe(canonical(join(repo, ".git")));
    expect(b.allowWrite).toContain(b.gitDir!);
    expect(b.allowWrite.some((p) => within("/tmp/x", p))).toBe(true);
    for (const s of [".claude", ".codex", ".opencode", "opencode.json"]) expect(b.denyWrite).toContain(join(b.root, s));
  });

  test("the per-user temp directory is writable; toyon's secrets can be neither read nor written", async () => {
    const { wt } = linkedWorktree();
    const secret = join(wt, "..", "home", "token");
    const b = await worktreeBounds(wt, [secret]);
    expect(b.allowWrite.some((p) => within(canonical(join(tmpdir(), "x")), p))).toBe(true);
    expect(b.denyRead).toContain(secret);
    expect(b.denyWrite).toContain(secret);
  });

  test("the secrets are the daemon's token, its agents file and a machine's git credentials", () => {
    const secrets = toyonSecrets({
      tokenFile: "/h/token",
      agentsFile: "/h/agents.json",
      gitCredentialsFile: "/h/git-credentials",
    } as never);
    expect(secrets).toEqual(["/h/token", "/h/agents.json", "/h/git-credentials"]);
  });

  test("a launch is prepared by the agent's own setup, which sees the bounds and adds to the environment", async () => {
    const { wt } = linkedWorktree();
    const seen: Bounds[] = [];
    const spec: AgentSpec = {
      id: "boxed",
      name: "Boxed",
      builtin: false,
      run: { kind: "command", command: "true" },
      confinement: "toyon-sandbox",
      systemPrompt: "prompt-prefix",
      loginHint: "",
      setup: async (_cwd, b) => {
        seen.push(b);
        return { env: { AGENT_CONFIG: "{}" } };
      },
    };
    const p = await prepareLaunch(wt, spec);
    expect(p.env).toEqual({ AGENT_CONFIG: "{}" });
    expect(seen).toEqual([p.bounds]);
  });

  test("the main checkout's own .git is inside root, so gitDir is null", async () => {
    const t = tmpRepo();
    cleanup = t.cleanup;
    const b = await worktreeBounds(t.repo);
    expect(b.gitDir).toBeNull();
  });

  test("writes settings.local.json, keeps the user's keys, excludes it from git once", async () => {
    const { repo, wt } = linkedWorktree();
    const file = join(wt, SETTINGS_REL);
    const b = await worktreeBounds(wt);
    await writeClaudeLocalSettings(wt, b);
    const first = JSON.parse(readFileSync(file, "utf8"));
    expect(first.sandbox.enabled).toBe(true);
    expect(first.sandbox.filesystem.allowWrite).toEqual(b.allowWrite);
    expect(first.sandbox.filesystem.denyRead).toEqual(b.denyRead);
    expect(first.permissions.defaultMode).toBe("default");
    // the user's own keys survive a rewrite; ours are replaced
    writeFileSync(
      file,
      JSON.stringify({ hooks: { x: 1 }, permissions: { allow: ["Bash(ls)"] }, sandbox: { enabled: false } }),
    );
    await writeClaudeLocalSettings(wt, b);
    const second = JSON.parse(readFileSync(file, "utf8"));
    expect(second.hooks).toEqual({ x: 1 });
    expect(second.permissions).toEqual({ allow: ["Bash(ls)"], defaultMode: "default", deny: claudeDenyRules() });
    expect(second.sandbox.enabled).toBe(true);
    expect(existsSync(`${file}.tmp`)).toBe(false);
    // ignored by git, and the exclude line is added once even after two writes
    expect(sh(wt, GIT, "status", "--porcelain")).toBe("");
    const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n").filter((l) => l === SETTINGS_REL)).toHaveLength(1);
  });

  test("the user's own deny rules survive and ours are never written twice", async () => {
    const { wt } = linkedWorktree();
    const file = join(wt, SETTINGS_REL);
    const b = await worktreeBounds(wt);
    mkdirSync(join(wt, ".claude"));
    writeFileSync(file, JSON.stringify({ permissions: { deny: ["Bash(rm -rf:*)", "Bash(git push:*)"] } }));
    await writeClaudeLocalSettings(wt, b);
    await writeClaudeLocalSettings(wt, b);
    const deny: string[] = JSON.parse(readFileSync(file, "utf8")).permissions.deny;
    expect(deny[0]).toBe("Bash(rm -rf:*)");
    expect(deny.filter((r) => r === "Bash(git push:*)")).toHaveLength(1);
    for (const r of claudeDenyRules()) expect(deny).toContain(r);
  });

  test("an unparsable existing file is kept as .bak and replaced", async () => {
    const { wt } = linkedWorktree();
    const file = join(wt, SETTINGS_REL);
    const b = await worktreeBounds(wt);
    await writeClaudeLocalSettings(wt, b);
    writeFileSync(file, "{ not json");
    await writeClaudeLocalSettings(wt, b);
    expect(readFileSync(`${file}.bak`, "utf8")).toBe("{ not json");
    expect(JSON.parse(readFileSync(file, "utf8")).sandbox.enabled).toBe(true);
  });
});
