// Toyon's own tools, served to each worktree's agent over MCP (streamable HTTP, JSON responses).
// Hand-rolled: one tool and four JSON-RPC methods are the whole protocol here, and the SDK's
// server would pull a web framework into the bundled daemon for them. Stateless, so a daemon
// restart under a running agent costs nothing: the next call carries everything it needs.

import { randomBytes } from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";
import { TOYON_MCP_SERVER } from "@toyon/shared";
import { UserError } from "../core/errors.ts";
import { log } from "../core/log.ts";
import { sameSecret } from "../core/remote.ts";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  text: string;
  isError?: boolean;
}

/** what the server serves, per worktree: the list and the calls, both the services' business */
export interface McpTools {
  list(worktreeId: string): McpTool[];
  call(worktreeId: string, name: string, args: unknown): Promise<McpToolResult>;
}

/** one of Toyon's tools, owned by the service that does its work: how it reads to a worktree's
 * agent (the list is asked afresh each time, so a description can name what is open right now),
 * and the call, whose arguments arrive unchecked */
export interface ToolProvider {
  tool(worktreeId: string): McpTool;
  call(worktreeId: string, args: unknown): Promise<McpToolResult> | McpToolResult;
}

/** The tools the daemon serves, registered by the services that own them. The server is built
 * before those services and asks this only once an agent calls, so a service registers itself
 * when it exists and nothing has to name every tool in one place. */
export class ToolSet implements McpTools {
  private providers: ToolProvider[] = [];

  add(provider: ToolProvider): void {
    this.providers.push(provider);
  }

  list(worktreeId: string): McpTool[] {
    return this.providers.map((p) => p.tool(worktreeId));
  }

  async call(worktreeId: string, name: string, args: unknown): Promise<McpToolResult> {
    const provider = this.providers.find((p) => p.tool(worktreeId).name === name);
    if (!provider) return { text: `unknown tool ${name}`, isError: true };
    return provider.call(worktreeId, args);
  }
}

/** the protocol revisions the client may name; the newest is what an unknown one is answered with */
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

/** the largest request body taken: a tool call carries a message of some thousands of characters */
const BODY_MAX_BYTES = 64 * 1024;

const PARSE_ERROR = -32700;
const INVALID_PARAMS = -32602;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

type Json = Record<string, unknown>;

interface JsonRpcError {
  jsonrpc: "2.0";
  id: unknown;
  error: { code: number; message: string };
}

const rpcError = (id: unknown, code: number, message: string): JsonRpcError => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

const asRecord = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);

export class ToyonMcp {
  /** the bearer each worktree's running agent holds; a worktree with no agent up has none */
  private bearers = new Map<string, string>();

  constructor(
    private d: {
      /** where the agent reaches this worktree's server: the daemon's bound loopback address */
      url: (worktreeId: string) => string;
      version: string;
      tools: McpTools;
    },
  ) {}

  /** A fresh bearer for this worktree's agent process, replacing any earlier one: the old process
   * is gone or going, and a credential that outlived it would be one more thing to have leaked.
   * In memory only, never logged. It shows in the agent's process arguments, which is accepted: it
   * grants one propose-only tool on one chat, and the daemon token is a different secret. */
  open(worktreeId: string): acp.McpServer {
    const bearer = randomBytes(32).toString("base64url");
    this.bearers.set(worktreeId, bearer);
    return {
      type: "http",
      name: TOYON_MCP_SERVER,
      url: this.d.url(worktreeId),
      headers: [{ name: "Authorization", value: `Bearer ${bearer}` }],
    };
  }

  close(worktreeId: string): void {
    this.bearers.delete(worktreeId);
  }

  async fetch(req: Request, worktreeId: string): Promise<Response> {
    // the client never sends an Origin; a browser always does, and a page on this machine must not
    // reach an agent's tool even with a bearer it somehow read
    if (req.headers.get("origin") !== null) return new Response("forbidden", { status: 403 });
    // the client treats 405 on GET as "no server stream" and on DELETE as "no session to end"
    if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
    // one answer for an unknown worktree, a retired bearer and a wrong one, so ids are not
    // enumerable from here; the daemon token is just another wrong bearer
    const bearer = this.bearers.get(worktreeId);
    if (!bearer || !sameSecret(req.headers.get("authorization"), `Bearer ${bearer}`)) {
      return new Response("unauthorized", { status: 401 });
    }
    const body = await readCapped(req, BODY_MAX_BYTES);
    if (body === null) return new Response("request body too large", { status: 413 });
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return Response.json(rpcError(null, PARSE_ERROR, "parse error"), { status: 400 });
    }
    const batch = Array.isArray(parsed);
    const messages = batch ? (parsed as unknown[]) : [parsed];
    const replies: unknown[] = [];
    for (const m of messages) {
      const reply = await this.handle(worktreeId, m);
      if (reply !== undefined) replies.push(reply);
    }
    // notifications only: the client expects an empty 202
    if (replies.length === 0) return new Response(null, { status: 202 });
    return Response.json(batch ? replies : replies[0], {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  }

  /** one JSON-RPC message in, its response out; undefined for a notification */
  private async handle(worktreeId: string, raw: unknown): Promise<unknown> {
    const m = asRecord(raw);
    if (!m || typeof m.method !== "string") return rpcError(m?.id ?? null, PARSE_ERROR, "parse error");
    const method = m.method;
    const id = m.id;
    const params = asRecord(m.params) ?? {};
    // a notification has no id and gets no reply; the client's `notifications/initialized` is one
    if (method.startsWith("notifications/")) return undefined;
    if (id === undefined) return undefined;
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    switch (method) {
      case "initialize": {
        const asked = params.protocolVersion;
        const protocolVersion =
          typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked) ? asked : DEFAULT_PROTOCOL_VERSION;
        return ok({
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: TOYON_MCP_SERVER, version: this.d.version },
        });
      }
      case "ping":
        return ok({});
      case "tools/list": {
        const tools = this.d.tools.list(worktreeId);
        log.debug(worktreeId, `mcp: tools/list answered with ${tools.map((t) => t.name).join(", ") || "nothing"}`);
        return ok({ tools });
      }
      case "tools/call": {
        const name = params.name;
        if (typeof name !== "string" || !this.d.tools.list(worktreeId).some((t) => t.name === name)) {
          return rpcError(id, INVALID_PARAMS, `unknown tool ${typeof name === "string" ? name : ""}`.trim());
        }
        try {
          const r = await this.d.tools.call(worktreeId, name, params.arguments ?? {});
          return ok({ content: [{ type: "text", text: r.text }], ...(r.isError ? { isError: true } : {}) });
        } catch (e) {
          // a refusal in the person's words is the tool's answer, for the agent to read and act on
          if (e instanceof UserError) return ok({ content: [{ type: "text", text: e.message }], isError: true });
          log.error(worktreeId, `mcp: ${name} failed`, e);
          return rpcError(id, INTERNAL_ERROR, "internal error");
        }
      }
      default:
        return rpcError(id, METHOD_NOT_FOUND, `method not found: ${method}`);
    }
  }
}

/** the body as text, or null once it has run past `max`: read chunk by chunk rather than trusted
 * to the server's own ceiling, which is sized for uploads */
async function readCapped(req: Request, max: number): Promise<string | null> {
  // a body is read chunk by chunk under Bun, which the DOM's type for it does not say
  const body = req.body as AsyncIterable<Uint8Array> | null;
  if (!body) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  // leaving the loop early returns the iterator, which cancels the stream; the client is being
  // told 413 and what is left of its body is not read
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > max) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
