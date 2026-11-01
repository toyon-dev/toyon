import { describe, expect, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk/unstable";
import type { AgentInfo, AgentLimits, AgentPicks, AuthStatus, ModelChoice } from "@toyon/shared";
import { fakeAgents } from "../../test/helpers/fakes.ts";
import { AUTH_STATUS_UPDATE_METHOD } from "./acp/authstatus.ts";
import { AgentReadiness, type AgentReadinessDeps, CHECK_COOLDOWN_MS } from "./readiness.ts";

// The adapter runs in-process through the SDK's transport-less connect: every ACP exchange is real
// and nothing is spawned.
function fakeAdapter(
  opts: { logout?: boolean; pushOnInit?: AuthStatus; pushOnLogout?: AuthStatus; failNew?: true | Error } = {},
) {
  const seen = { connects: 0, logouts: 0, sessions: 0, closes: 0, prompts: 0, kills: 0 };
  const app = acp
    .agent({ name: "fake" })
    .onRequest(acp.methods.agent.initialize, async (c) => {
      // codex-acp reports the identity it starts on only once initialize has answered
      if (opts.pushOnInit) await c.client.notify(AUTH_STATUS_UPDATE_METHOD, { authStatus: opts.pushOnInit });
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { sessionCapabilities: { close: {} }, ...(opts.logout ? { auth: { logout: {} } } : {}) },
        authMethods: [],
      };
    })
    .onRequest(acp.methods.agent.session.new, async () => {
      seen.sessions++;
      if (opts.failNew === true) throw acp.RequestError.authRequired();
      if (opts.failNew) throw opts.failNew;
      return {
        sessionId: "s1",
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select" as const,
            currentValue: "gpt-a",
            options: [
              { value: "gpt-a", name: "gpt-a" },
              { value: "gpt-b", name: "gpt-b", description: "faster" },
            ],
          },
        ],
      };
    })
    .onRequest(acp.methods.agent.session.close, async () => {
      seen.closes++;
      return {};
    })
    .onRequest(acp.methods.agent.session.prompt, async () => {
      seen.prompts++;
      return { stopReason: "end_turn" as const };
    })
    .onRequest(acp.methods.agent.logout, async (c) => {
      seen.logouts++;
      // both real adapters push their new identity while handling logout, before the response
      if (opts.pushOnLogout) await c.client.notify(AUTH_STATUS_UPDATE_METHOD, { authStatus: opts.pushOnLogout });
      return {};
    });
  const connect: AgentReadinessDeps["connect"] = async (clientApp) => {
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

const ready = (id: string): AgentInfo => ({ id, name: id, available: true, sandboxed: false });
const infos = (): AgentInfo[] => [ready("claude"), ready("codex")];
const listed: ModelChoice[] = [
  { id: "gpt-a", name: "gpt-a" },
  { id: "gpt-b", name: "gpt-b", description: "faster" },
];

function world(
  opts: Parameters<typeof fakeAdapter>[0] = {},
  extra: { infos?: AgentInfo[]; models?: Record<string, ModelChoice[]> } = {},
) {
  const agents = fakeAgents("/nowhere");
  const adapter = fakeAdapter(opts);
  const learned: Array<[string, string, ModelChoice[]]> = [];
  const models = extra.models ?? {};
  /** the model each agent's look opened on, by agent id */
  const ran: Record<string, string> = {};
  /** what the composer picked for new worktrees, by agent id */
  const picked: Record<string, AgentPicks> = {};
  let now = 1_000_000;
  const readiness = new AgentReadiness({
    infos: () => extra.infos ?? infos(),
    require: (id) => agents.require(id),
    connect: adapter.connect,
    cwd: "/nowhere",
    options: (id, category) => (category === "model" ? (models[id] ?? []) : []),
    runs: (id, category) => (category === "model" ? ran[id] : undefined),
    picks: (id) => picked[id] ?? {},
    learned: (id, category, choices, runs) => {
      learned.push([id, category, choices]);
      if (category === "model") {
        models[id] = choices;
        ran[id] = runs;
      }
    },
    quick: () => false,
    now: () => now,
  });
  let changes = 0;
  readiness.onChange = () => changes++;
  return {
    readiness,
    adapter,
    learned,
    models,
    ran,
    picked,
    changes: () => changes,
    tick: (ms: number) => (now += ms),
  };
}

const max: AuthStatus = { kind: "account", label: "Claude Max", account: { email: "who@example.com" } };
const none: AuthStatus = { kind: "none", label: "Not logged in" };

describe("AgentReadiness: what sessions report", () => {
  test("an agent nothing was observed for is the registry's row alone", () => {
    const w = world();
    expect(w.readiness.describe()).toEqual(infos());
  });

  test("what a connection observed shows up on that agent's row only", () => {
    const w = world();
    w.readiness.observe("claude", { canLogout: true });
    w.readiness.observe("claude", { status: max });
    const [claude, codex] = w.readiness.describe();
    expect(claude).toEqual({ ...ready("claude"), auth: max, canLogout: true });
    expect(codex).toEqual(ready("codex"));
  });

  test("what the composer picked for new worktrees rides the row, and only while something is picked", () => {
    const w = world();
    w.picked.claude = { model: "fable", effort: "high" };
    const [claude, codex] = w.readiness.describe();
    expect(claude).toEqual({ ...ready("claude"), picks: { model: "fable", effort: "high" } });
    expect(codex).toEqual(ready("codex"));
    w.picked.claude = {};
    expect(w.readiness.describe()[0]).toEqual(ready("claude"));
  });

  test("observing the same thing twice is not a change the shell has to hear about", () => {
    const w = world();
    w.readiness.observe("claude", { canLogout: true, status: max });
    expect(w.changes()).toBe(1);
    w.readiness.observe("claude", { canLogout: true, status: { ...max, account: { email: "who@example.com" } } });
    expect(w.changes()).toBe(1);
    w.readiness.observe("claude", { status: none });
    expect(w.changes()).toBe(2);
  });

  test("the plan figures a reply reported sit on the agent's row, and the latest word wins", () => {
    const w = world();
    const first: AgentLimits = { status: "allowed", windows: { five_hour: { used: 0.2, resetsAt: 9_000 } }, at: 1 };
    w.readiness.observeLimits("claude", first);
    expect(w.readiness.describe()[0]!.limits).toEqual(first);
    expect(w.readiness.describe()[1]!.limits).toBeUndefined();
    const later: AgentLimits = { ...first, windows: { five_hour: { used: 0.3, resetsAt: 9_000 } }, at: 2 };
    w.readiness.observeLimits("claude", later);
    expect(w.readiness.describe()[0]!.limits).toEqual(later);
    expect(w.changes()).toBe(2);
    // the credentials observed on the same agent and the figures keep each other
    w.readiness.observe("claude", { status: max });
    expect(w.readiness.describe()[0]).toMatchObject({ auth: max, limits: later });
  });

  test("the same figures read off another reply are not a change the shell has to hear about", () => {
    const w = world();
    const read: AgentLimits = {
      status: "allowed",
      binding: "five_hour",
      windows: { five_hour: { used: 0.2, resetsAt: 9_000 }, seven_day: { used: 0.1, resetsAt: 90_000 } },
      at: 1,
    };
    w.readiness.observeLimits("claude", read);
    w.readiness.observeLimits("claude", { ...read, at: 2 });
    expect(w.changes()).toBe(1);
    w.readiness.observeLimits("claude", { ...read, status: "allowed_warning", at: 3 });
    expect(w.changes()).toBe(2);
  });

  test("a status the agent sent in a shape we cannot read never reaches the cache", () => {
    const w = world();
    w.readiness.observe("claude", { status: null });
    expect(w.readiness.describe()[0]!.auth).toBeUndefined();
    expect(w.changes()).toBe(0);
  });

  test("the models and the quick model a session listed ride the same row", () => {
    const w = world({}, { models: { claude: listed } });
    expect(w.readiness.describe()[0]).toEqual({ ...ready("claude"), models: listed });
  });
});

describe("AgentReadiness: looking again", () => {
  test("reads an unknown agent's options off a session it opens and closes, prompts nothing, and keeps the identity it was handed", async () => {
    const w = world({ pushOnInit: max }, { models: { claude: listed } });
    await w.readiness.checkMissing();
    expect(w.learned).toEqual([["codex", "model", listed]]);
    expect(w.adapter.seen).toMatchObject({ connects: 1, sessions: 1, closes: 1, prompts: 0, kills: 1 });
    // the model the look's session opened on is the agent's own default, and rides the row
    expect(w.ran).toEqual({ codex: "gpt-a" });
    expect(w.readiness.describe()[1]).toMatchObject({ models: listed, defaultModel: "gpt-a", auth: max });
  });

  test("an agent that is not installed yet is looked at once it is, and once only until the cooldown", async () => {
    const codex: AgentInfo = { ...ready("codex"), available: false, reason: "installing" };
    const w = world({ failNew: true }, { infos: [codex] });
    await w.readiness.checkMissing();
    await w.readiness.check("codex");
    expect(w.adapter.seen.sessions).toBe(0);
    codex.available = true;
    await Promise.all([w.readiness.checkMissing(), w.readiness.checkMissing(), w.readiness.check("codex")]);
    await w.readiness.checkMissing();
    expect(w.adapter.seen.sessions).toBe(1);
    w.tick(CHECK_COOLDOWN_MS);
    await w.readiness.check("codex");
    expect(w.adapter.seen.sessions).toBe(2);
  });

  test("an agent nobody knows is nothing to look at, and never a throw", async () => {
    const w = world();
    await w.readiness.check("nope");
    expect(w.adapter.seen.connects).toBe(0);
  });

  test("a session refused for want of a credential leaves the agent's own login hint on the row", async () => {
    const w = world({ failNew: true });
    await w.readiness.check("claude");
    expect(w.learned).toEqual([]);
    expect(w.adapter.seen).toMatchObject({ sessions: 1, kills: 1 });
    expect(w.readiness.describe()[0]).toEqual({ ...ready("claude"), checkFailed: "claude: log in" });
    expect(w.changes()).toBe(1);
  });

  test("any other failure leaves the process's own first line", async () => {
    const w = world({ failNew: new Error("boom\nand a stack of it") });
    await w.readiness.check("claude");
    expect(w.readiness.describe()[0]!.checkFailed).toBe("boom");
  });

  test("an agent that cannot be started says so, and the next look is after the cooldown", async () => {
    const w = world();
    const broken = new AgentReadiness({
      infos,
      require: () => {
        throw new Error("never");
      },
      connect: () => Promise.reject(new Error("spawn ENOENT")),
      cwd: "/nowhere",
      options: () => [],
      runs: () => undefined,
      picks: () => ({}),
      learned: () => {},
      quick: () => false,
    });
    await broken.checkMissing();
    expect(broken.describe()[0]!.checkFailed).toMatch(/never|ENOENT/);
    expect(w.adapter.seen.connects).toBe(0);
  });

  test("a positive agent is never looked at: models listed, nothing failed, no login it said it lacks", async () => {
    const w = world({}, { models: { claude: listed, codex: listed } });
    w.readiness.observe("claude", { status: max });
    // codex has listed models and never reported an identity (OpenCode's adapter pushes none)
    await w.readiness.checkMissing();
    await w.readiness.check("claude");
    await w.readiness.check("codex");
    expect(w.adapter.seen.connects).toBe(0);
  });

  test("a login the agent said it lacks is negative even with models listed, and one look settles it", async () => {
    const w = world({ pushOnInit: max }, { models: { claude: listed } });
    w.readiness.observe("claude", { status: none });
    await w.readiness.check("claude");
    expect(w.adapter.seen.connects).toBe(1);
    expect(w.readiness.describe()[0]!.auth).toEqual(max);
  });

  test("a look that is handed an identity and then fails keeps both, and the shell hears it once", async () => {
    const w = world({ pushOnInit: max, failNew: true });
    await w.readiness.check("claude");
    expect(w.readiness.describe()[0]).toMatchObject({ auth: max, checkFailed: "claude: log in" });
    expect(w.changes()).toBe(1);
  });

  test("a look that succeeds clears what the last one left, and so does a session seeing a login", async () => {
    const w = world({ failNew: true });
    await w.readiness.check("claude");
    expect(w.readiness.describe()[0]!.checkFailed).toBe("claude: log in");
    w.readiness.observe("claude", { status: max });
    expect(w.readiness.describe()[0]!.checkFailed).toBeUndefined();
    expect(w.changes()).toBe(2);
    // and the other way: a failed row, then a look that lists models
    const ok = world({}, {});
    ok.readiness.observe("codex", { status: none });
    await ok.readiness.check("codex");
    expect(ok.readiness.describe()[1]).toEqual({
      ...ready("codex"),
      models: listed,
      defaultModel: "gpt-a",
      auth: none,
    });
  });

  test("two looks at once share one spawn", async () => {
    const w = world({ failNew: true });
    await Promise.all([w.readiness.check("claude"), w.readiness.check("claude")]);
    expect(w.adapter.seen.connects).toBe(1);
  });

  test("one agent's failure does not stop the next from being looked at", async () => {
    const w = world({ failNew: true });
    await w.readiness.checkMissing();
    expect(w.adapter.seen.sessions).toBe(2);
    expect(w.readiness.describe().map((a) => a.checkFailed)).toEqual(["claude: log in", "codex: log in"]);
  });
});

describe("AgentReadiness: signing out", () => {
  test("logout runs over a connection of its own, records what the agent then reports, and reaps it", async () => {
    const w = world({ logout: true, pushOnLogout: none });
    w.readiness.observe("claude", { canLogout: true, status: max });
    await w.readiness.logout("claude");
    expect(w.adapter.seen).toMatchObject({ connects: 1, logouts: 1, kills: 1 });
    expect(w.readiness.describe()[0]!.auth).toEqual(none);
  });

  test("the identity the connection opened on is not mistaken for the one it ends on", async () => {
    const w = world({ logout: true, pushOnInit: max });
    await w.readiness.logout("claude");
    // it reported "Claude Max" on the way in and nothing on the way out: that is not a new identity
    expect(w.readiness.describe()[0]!.auth).toBeUndefined();
  });

  test("a silent logout forgets the old identity instead of guessing the new one", async () => {
    const w = world({ logout: true });
    w.readiness.observe("claude", { canLogout: true, status: max });
    await w.readiness.logout("claude");
    const row = w.readiness.describe()[0]!;
    expect(row.auth).toBeUndefined();
    // still worth offering: the capability came from the agent, not from the credential
    expect(row.canLogout).toBe(true);
  });

  test("a sign-out drops what a look had found, so the next look is a fresh one", async () => {
    const w = world({ logout: true, failNew: true });
    await w.readiness.check("claude");
    expect(w.readiness.describe()[0]!.checkFailed).toBe("claude: log in");
    await w.readiness.logout("claude");
    expect(w.readiness.describe()[0]!.checkFailed).toBeUndefined();
    await w.readiness.check("claude");
    expect(w.adapter.seen.connects).toBe(3);
  });

  test("concurrent logouts share one run", async () => {
    const w = world({ logout: true });
    await Promise.all([w.readiness.logout("claude"), w.readiness.logout("claude")]);
    expect(w.adapter.seen.logouts).toBe(1);
  });

  test("a sign-out pressed during a look waits for it, then signs out; a look during a sign-out joins it", async () => {
    const w = world({ logout: true, failNew: true });
    const look = w.readiness.check("claude");
    const out = w.readiness.logout("claude");
    const second = w.readiness.check("claude");
    await Promise.all([look, out, second]);
    expect(w.adapter.seen).toMatchObject({ connects: 2, logouts: 1 });
  });

  test("an agent that never advertised logout says so, its process is still reaped, and a look that joined it spawns nothing", async () => {
    const w = world();
    const out = w.readiness.logout("claude");
    const look = w.readiness.check("claude");
    await expect(out).rejects.toThrow(/cannot be signed out/);
    await look;
    expect(w.adapter.seen.kills).toBe(1);
  });

  test("an unknown agent is the registry's error", async () => {
    const w = world({ logout: true });
    await expect(w.readiness.logout("nope")).rejects.toThrow(/unknown agent/);
  });
});
