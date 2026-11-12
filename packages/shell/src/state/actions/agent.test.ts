import { describe, expect, test } from "bun:test";
import type { AgentInfo } from "@toyon/shared";
import { adapterRow, agentItems, installMsg, installVerb } from "./agent.ts";

const agent = (over: Partial<AgentInfo> = {}): AgentInfo => ({
  id: "claude",
  name: "Claude Code",
  available: true,
  sandboxed: true,
  ...over,
});

const HELD = "blocked by minimum-release-age. Wait it out, or install anyway";
const behind = { runs: "0.99.1-toyon.1", pinned: "0.106.0-toyon.1" };

describe("the adapter's install", () => {
  test("an agent on its pinned adapter has no row and no verb", () => {
    expect(adapterRow(agent())).toBeNull();
    expect(installVerb(agent())).toBeNull();
    // nor one whose install would not help: the daemon sends no `install`
    expect(adapterRow(agent({ available: false, reason: "no build for linux riscv64" }))).toBeNull();
  });

  test("one never fetched, and one whose fetch failed with nothing on disk, name the state and the verb", () => {
    expect(adapterRow(agent({ available: false, install: "missing" }))).toEqual({
      text: "adapter is not installed",
      verb: "install",
    });
    expect(adapterRow(agent({ available: false, install: { failed: "registry unreachable" } }))).toEqual({
      text: "adapter did not install",
      verb: "install again",
      why: "registry unreachable",
    });
  });

  test("a held upgrade names both versions beside an agent that still runs, and the press goes past the rule", () => {
    const a = agent({ install: { failed: HELD, held: true, behind } });
    expect(adapterRow(a)).toEqual({
      text: "runs adapter 0.99.1-toyon.1; 0.106.0-toyon.1 is held back",
      verb: "install anyway",
      why: HELD,
    });
    expect(installMsg(a)).toEqual({ t: "install-agent", agent: "claude", anyway: true });
    // the same verb in the agent's menu: the settings chip and the picker row
    expect(agentItems(a, { sock: null, dispatch: () => {} }).map((i) => i.label)).toEqual(["install anyway"]);
  });

  test("a failed upgrade offers another plain fetch", () => {
    const a = agent({ install: { failed: "registry unreachable", behind } });
    expect(adapterRow(a)).toEqual({
      text: "runs adapter 0.99.1-toyon.1; 0.106.0-toyon.1 did not install",
      verb: "install again",
      why: "registry unreachable",
    });
    expect(installMsg(a)).toEqual({ t: "install-agent", agent: "claude" });
  });

  test("a download under way holds the row with nothing to press", () => {
    expect(adapterRow(agent({ installing: true }))).toEqual({ text: "adapter", verb: null, busy: true });
  });
});
