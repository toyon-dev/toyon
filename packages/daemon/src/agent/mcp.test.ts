import { describe, expect, test } from "bun:test";
import type * as acp from "@agentclientprotocol/sdk";
import { UserError } from "../core/errors.ts";
import { type McpTool, type McpToolResult, type ToolProvider, ToolSet, ToyonMcp } from "./mcp.ts";

// The hand-rolled MCP server: who gets in (a per-worktree bearer and nothing else), the
// streamable-HTTP shape Claude Code's client expects, and the four methods it answers.

const tool: McpTool = { name: "handoff", description: "propose", inputSchema: { type: "object" } };
const calls: Array<[string, string, unknown]> = [];
let answer: McpToolResult | Error = { text: "proposed" };
const mcp = new ToyonMcp({
  url: (id) => `http://127.0.0.1:4141/mcp/${id}`,
  version: "9.9.9",
  tools: {
    list: (id) => (id === "none" ? [] : [tool]),
    call: async (id, name, args) => {
      calls.push([id, name, args]);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  },
});

/** the Authorization value on the http entry `open` made; the union's other arms carry none */
const bearerOf = (entry: acp.McpServer) =>
  ("headers" in entry ? entry.headers : undefined)?.find((h) => h.name === "Authorization")?.value ?? "";

const post = (
  worktreeId: string,
  body: unknown,
  init: { auth?: string; method?: string; headers?: Record<string, string>; raw?: string } = {},
) =>
  mcp.fetch(
    new Request(`http://127.0.0.1:4141/mcp/${worktreeId}`, {
      method: init.method ?? "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(init.auth ? { authorization: init.auth } : {}),
        ...init.headers,
      },
      ...(init.method === "GET" || init.method === "DELETE" ? {} : { body: init.raw ?? JSON.stringify(body) }),
    }),
    worktreeId,
  );

const rpc = (method: string, params?: unknown, id: unknown = 1) => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params !== undefined ? { params } : {}),
});

describe("ToyonMcp bearers", () => {
  test("open mints an http entry with a bearer; no, wrong and retired bearers and the daemon token are the same 401", async () => {
    const entry = mcp.open("w1");
    expect(entry).toMatchObject({ type: "http", name: "toyon", url: "http://127.0.0.1:4141/mcp/w1" });
    const auth = bearerOf(entry);
    expect(auth).toMatch(/^Bearer [A-Za-z0-9_-]{40,}$/);
    const ok = await post("w1", rpc("ping"), { auth });
    expect(ok.status).toBe(200);
    const refused = await Promise.all([
      post("w1", rpc("ping")),
      post("w1", rpc("ping"), { auth: "Bearer nope" }),
      post("w1", rpc("ping"), { auth: "Bearer secret-daemon-token" }),
      post("unknown", rpc("ping"), { auth }),
    ]);
    for (const r of refused) {
      expect(r.status).toBe(401);
      expect(await r.text()).toBe("unauthorized");
    }
    mcp.close("w1");
    const retired = await post("w1", rpc("ping"), { auth });
    expect(retired.status).toBe(401);
    expect(await retired.text()).toBe("unauthorized");
  });

  test("a second open replaces the bearer: only the latest works", async () => {
    const first = bearerOf(mcp.open("w2"));
    const second = bearerOf(mcp.open("w2"));
    expect(first).not.toBe(second);
    expect((await post("w2", rpc("ping"), { auth: first })).status).toBe(401);
    expect((await post("w2", rpc("ping"), { auth: second })).status).toBe(200);
    mcp.close("w2");
  });

  test("GET and DELETE are 405 with allow: POST; an Origin header is 403; no CORS headers ever", async () => {
    const auth = bearerOf(mcp.open("w3"));
    for (const method of ["GET", "DELETE"]) {
      const r = await post("w3", undefined, { auth, method });
      expect(r.status).toBe(405);
      expect(r.headers.get("allow")).toBe("POST");
    }
    const origin = await post("w3", rpc("ping"), { auth, headers: { origin: "http://127.0.0.1:4141" } });
    expect(origin.status).toBe(403);
    const ok = await post("w3", rpc("ping"), { auth });
    expect(ok.headers.get("access-control-allow-origin")).toBeNull();
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.headers.get("mcp-session-id")).toBeNull();
    mcp.close("w3");
  });

  test("a body past 64 KiB is 413; unparsable JSON is a 400 parse error", async () => {
    const auth = bearerOf(mcp.open("w4"));
    const big = await post("w4", undefined, { auth, raw: `{"pad":"${"x".repeat(70 * 1024)}"}` });
    expect(big.status).toBe(413);
    const bad = await post("w4", undefined, { auth, raw: "{not json" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    mcp.close("w4");
  });
});

describe("ToyonMcp methods", () => {
  const auth = bearerOf(mcp.open("w5"));

  test("initialize echoes a supported protocol version and falls back to 2025-06-18", async () => {
    const r = await post("w5", rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {} }), { auth });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(await r.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "toyon", version: "9.9.9" },
      },
    });
    const future = await post("w5", rpc("initialize", { protocolVersion: "2099-01-01" }), { auth });
    expect(((await future.json()) as { result: { protocolVersion: string } }).result.protocolVersion).toBe(
      "2025-06-18",
    );
  });

  test("notifications/initialized is a 202 with no body; ping answers an empty result", async () => {
    const n = await post("w5", { jsonrpc: "2.0", method: "notifications/initialized" }, { auth });
    expect(n.status).toBe(202);
    expect(await n.text()).toBe("");
    expect(await (await post("w5", rpc("ping", undefined, "p"), { auth })).json()).toEqual({
      jsonrpc: "2.0",
      id: "p",
      result: {},
    });
  });

  test("tools/list returns what the service lists for that worktree", async () => {
    expect(await (await post("w5", rpc("tools/list"), { auth })).json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [tool] },
    });
  });

  test("tools/call passes worktree, name and arguments, and wraps the text and isError", async () => {
    calls.length = 0;
    answer = { text: "proposed" };
    const ok = await post("w5", rpc("tools/call", { name: "handoff", arguments: { project: "b" } }), { auth });
    expect(await ok.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "proposed" }] },
    });
    expect(calls).toEqual([["w5", "handoff", { project: "b" }]]);
    answer = { text: "no such project", isError: true };
    const refused = await post("w5", rpc("tools/call", { name: "handoff", arguments: {} }), { auth });
    expect(await refused.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "no such project" }], isError: true },
    });
  });

  test("a UserError from the tool is isError text; any other throw is logged and -32603", async () => {
    answer = new UserError("that chat is gone");
    const user = await post("w5", rpc("tools/call", { name: "handoff", arguments: {} }), { auth });
    expect(await user.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "that chat is gone" }], isError: true },
    });
    answer = new Error("disk on fire");
    const bug = await post("w5", rpc("tools/call", { name: "handoff", arguments: {} }), { auth });
    expect(bug.status).toBe(200);
    expect(await bug.json()).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "internal error" } });
    answer = { text: "proposed" };
  });

  test("an unknown tool is -32602 and an unknown method -32601, both in a 200", async () => {
    const tool = await post("w5", rpc("tools/call", { name: "nope", arguments: {} }), { auth });
    expect(tool.status).toBe(200);
    expect(await tool.json()).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "unknown tool nope" } });
    const method = await post("w5", rpc("resources/list"), { auth });
    expect(method.status).toBe(200);
    expect(await method.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32601, message: "method not found: resources/list" },
    });
  });

  test("a batch answers as a batch, with its notifications left out", async () => {
    const r = await post(
      "w5",
      [rpc("ping", undefined, 1), { jsonrpc: "2.0", method: "notifications/initialized" }, rpc("ping", undefined, 2)],
      { auth },
    );
    expect(await r.json()).toEqual([
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", id: 2, result: {} },
    ]);
  });
});

describe("ToolSet", () => {
  const provider = (name: string, text: string): ToolProvider => ({
    tool: (worktreeId) => ({ name, description: `${name} for ${worktreeId}`, inputSchema: { type: "object" } }),
    call: async (worktreeId, args) => ({ text: `${text}:${worktreeId}:${JSON.stringify(args)}` }),
  });

  test("lists what the services registered, in order, asked per worktree", () => {
    const set = new ToolSet();
    set.add(provider("handoff", "h"));
    set.add(provider("design_check", "d"));
    expect(set.list("w1").map((t) => [t.name, t.description])).toEqual([
      ["handoff", "handoff for w1"],
      ["design_check", "design_check for w1"],
    ]);
  });

  test("routes a call by name and refuses one nobody registered", async () => {
    const set = new ToolSet();
    set.add(provider("handoff", "h"));
    expect(await set.call("w1", "handoff", { project: "b" })).toEqual({ text: 'h:w1:{"project":"b"}' });
    expect(await set.call("w1", "nope", {})).toEqual({ text: "unknown tool nope", isError: true });
  });
});
