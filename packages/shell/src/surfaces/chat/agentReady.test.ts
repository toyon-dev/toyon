import { describe, expect, test } from "bun:test";
import type { AgentInfo } from "@toyon/shared";
import { agentReadiness } from "./agentReady.ts";

const agent = (id: string, over: Partial<AgentInfo> = {}): AgentInfo => ({
  id,
  name: id === "claude" ? "Claude Code" : "Codex",
  available: true,
  sandboxed: true,
  ...over,
});

describe("agentReadiness", () => {
  test("says nothing for an agent that can run, or none at all", () => {
    expect(agentReadiness(agent("claude"), [agent("claude")], true)).toBeNull();
    expect(agentReadiness(undefined, [], true)).toBeNull();
  });

  test("an installed agent found short of a login says so, blocks nothing, and is quiet once it has models and no failure", () => {
    const short = agent("claude", { checkFailed: "Claude is not logged in" });
    expect(agentReadiness(short, [short], true)).toEqual({
      kind: "unready",
      text: "Claude is not logged in",
      retry: null,
    });
    expect(agentReadiness(short, [short, agent("codex")], false)).toEqual({
      kind: "unready",
      text: "Claude is not logged in",
      retry: null,
    });
    const out = agent("claude", { models: [{ id: "a", name: "a" }], auth: { kind: "none", label: "Not logged in" } });
    expect(agentReadiness(out, [out], true)).toEqual({
      kind: "unready",
      text: "Claude Code is not logged in",
      retry: null,
    });
    const fine = agent("claude", { models: [{ id: "a", name: "a" }], auth: { kind: "account", label: "Claude Max" } });
    expect(agentReadiness(fine, [fine], true)).toBeNull();
  });

  test("names the download while it runs, and the agent that is ready meanwhile", () => {
    const claude = agent("claude", { available: false, reason: "installing", installing: true });
    const codex = agent("codex");
    expect(agentReadiness(claude, [claude, codex], true)).toEqual({
      kind: "installing",
      text: "Claude Code is installing",
      retry: null,
      other: codex,
    });
    expect(agentReadiness(claude, [claude], true)).toEqual({
      kind: "installing",
      text: "Claude Code is installing",
      retry: null,
    });
  });

  test("a failed install reads as what did not land, offers the retry, and names an agent that is ready while one is still being chosen", () => {
    const claude = agent("claude", {
      available: false,
      reason: "install failed: registry unreachable",
      install: { failed: "registry unreachable" },
    });
    const codex = agent("codex");
    expect(agentReadiness(claude, [claude, codex], true)).toEqual({
      kind: "failed",
      text: "Claude Code did not install: registry unreachable",
      retry: "install again",
      other: codex,
    });
    // a worktree's agent is fixed: nothing to switch to
    expect(agentReadiness(claude, [claude, codex], false)).toEqual({
      kind: "failed",
      text: "Claude Code did not install: registry unreachable",
      retry: "install again",
    });
    // the other agent has to be able to run
    const broken = agent("codex", { available: false, reason: "not installed yet", install: "missing" });
    expect(agentReadiness(claude, [claude, broken], true)).not.toHaveProperty("other");
    // a rule of the machine's held the fetch: the press sets it aside rather than trying the same again
    const held = agent("claude", {
      available: false,
      reason: "install failed: blocked by minimum-release-age",
      install: { failed: "blocked by minimum-release-age", held: true },
    });
    expect(agentReadiness(held, [held], false)).toEqual({
      kind: "failed",
      text: "Claude Code did not install: blocked by minimum-release-age",
      retry: "install anyway",
    });
  });

  test("one never fetched offers the first install; one the daemon says no install can fix offers none", () => {
    const waiting = agent("codex", { available: false, reason: "not installed yet", install: "missing" });
    expect(agentReadiness(waiting, [waiting], true)).toMatchObject({
      text: "Codex is not ready: not installed yet",
      retry: "install",
    });
    const noBuild = agent("codex", { available: false, reason: "no build for freebsd x64" });
    expect(agentReadiness(noBuild, [noBuild], true)).toMatchObject({
      text: "Codex is not ready: no build for freebsd x64",
      retry: null,
    });
  });
});
