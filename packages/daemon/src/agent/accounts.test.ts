import { describe, expect, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentInfo, AuthStatus } from "@toyon/shared";
import { fakeAgents } from "../../test/helpers/fakes.ts";
import { AgentAccounts, type AgentAccountsDeps } from "./accounts.ts";
import { AUTH_STATUS_UPDATE_METHOD } from "./acp/authstatus.ts";

// The adapter runs in-process through the SDK's transport-less connect: every ACP exchange is real
// and nothing is spawned.
function fakeAdapter(opts: { logout?: boolean; pushOnInit?: AuthStatus; pushOnLogout?: AuthStatus } = {}) {
  const seen = { logouts: 0, kills: 0, connects: 0 };
  const app = acp
    .agent({ name: "fake" })
    .onRequest(acp.methods.agent.initialize, async (c) => {
      // codex-acp reports the identity it starts on only once initialize has answered
      if (opts.pushOnInit) await c.client.notify(AUTH_STATUS_UPDATE_METHOD, { authStatus: opts.pushOnInit });
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: opts.logout ? { auth: { logout: {} } } : {},
        authMethods: [],
      };
    })
    .onRequest(acp.methods.agent.logout, async (c) => {
      seen.logouts++;
      // both real adapters push their new identity while handling logout, before the response
      if (opts.pushOnLogout) await c.client.notify(AUTH_STATUS_UPDATE_METHOD, { authStatus: opts.pushOnLogout });
      return {};
    });
  const connect: AgentAccountsDeps["connect"] = async (clientApp) => {
    seen.connects++;
    const conn = clientApp.connect(app);
    return {
      conn,
      kill: async () => {
        seen.kills++;
        conn.close();
      },
      pid: null,
      exited: new Promise(() => {}),
      exitInfo: () => null,
    };
  };
  return { seen, connect };
}

const infos = (): AgentInfo[] => [
  { id: "claude", name: "claude", available: true, sandboxed: false },
  { id: "codex", name: "codex", available: true, sandboxed: false },
];

function world(opts: Parameters<typeof fakeAdapter>[0] = {}) {
  const agents = fakeAgents("/nowhere");
  const adapter = fakeAdapter(opts);
  const accounts = new AgentAccounts({ require: (id) => agents.require(id), connect: adapter.connect });
  let changes = 0;
  accounts.onChange = () => changes++;
  return { accounts, adapter, changes: () => changes };
}

const max: AuthStatus = { kind: "account", label: "Claude Max", account: { email: "who@example.com" } };

describe("AgentAccounts", () => {
  test("an agent nothing was observed for is passed through untouched", () => {
    const w = world();
    expect(w.accounts.describe(infos())).toEqual(infos());
  });

  test("what a connection observed shows up on that agent's row only", () => {
    const w = world();
    w.accounts.observe("claude", { canLogout: true });
    w.accounts.observe("claude", { status: max });
    const [claude, codex] = w.accounts.describe(infos());
    expect(claude).toEqual({
      id: "claude",
      name: "claude",
      available: true,
      sandboxed: false,
      auth: max,
      canLogout: true,
    });
    expect(codex).toEqual({ id: "codex", name: "codex", available: true, sandboxed: false });
  });

  test("observing the same thing twice is not a change the shell has to hear about", () => {
    const w = world();
    w.accounts.observe("claude", { canLogout: true, status: max });
    expect(w.changes()).toBe(1);
    w.accounts.observe("claude", { canLogout: true, status: { ...max, account: { email: "who@example.com" } } });
    expect(w.changes()).toBe(1);
    w.accounts.observe("claude", { status: { kind: "none", label: "Not logged in" } });
    expect(w.changes()).toBe(2);
  });

  test("a status the agent sent in a shape we cannot read never reaches the cache", () => {
    const w = world();
    w.accounts.observe("claude", { status: null });
    expect(w.accounts.describe(infos())[0]!.auth).toBeUndefined();
    expect(w.changes()).toBe(0);
  });

  test("logout runs over a connection of its own, records what the agent then reports, and reaps it", async () => {
    const w = world({ logout: true, pushOnLogout: { kind: "none", label: "Not logged in" } });
    w.accounts.observe("claude", { canLogout: true, status: max });
    await w.accounts.logout("claude");
    expect(w.adapter.seen).toEqual({ connects: 1, logouts: 1, kills: 1 });
    expect(w.accounts.describe(infos())[0]!.auth).toEqual({ kind: "none", label: "Not logged in" });
  });

  test("the identity the connection opened on is not mistaken for the one it ends on", async () => {
    const w = world({ logout: true, pushOnInit: max });
    await w.accounts.logout("claude");
    // it reported "Claude Max" on the way in and nothing on the way out: that is not a new identity
    expect(w.accounts.describe(infos())[0]!.auth).toBeUndefined();
  });

  test("a silent logout forgets the old identity instead of guessing the new one", async () => {
    const w = world({ logout: true });
    w.accounts.observe("claude", { canLogout: true, status: max });
    await w.accounts.logout("claude");
    const row = w.accounts.describe(infos())[0]!;
    expect(row.auth).toBeUndefined();
    // still worth offering: the capability came from the agent, not from the credential
    expect(row.canLogout).toBe(true);
  });

  test("concurrent logouts share one run", async () => {
    const w = world({ logout: true });
    await Promise.all([w.accounts.logout("claude"), w.accounts.logout("claude")]);
    expect(w.adapter.seen.logouts).toBe(1);
  });

  test("an agent that never advertised logout says so, and its process is still reaped", async () => {
    const w = world();
    await expect(w.accounts.logout("claude")).rejects.toThrow(/cannot be signed out/);
    expect(w.adapter.seen.kills).toBe(1);
  });

  test("an unknown agent is the registry's error", async () => {
    const w = world({ logout: true });
    await expect(w.accounts.logout("nope")).rejects.toThrow(/unknown agent/);
  });
});
