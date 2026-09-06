import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { spawnAcp } from "./transport.ts";

const FIXTURE = join(import.meta.dir, "../../../test/fixtures/acp-echo-agent.ts");
const launch = (env: Record<string, string> = {}) => ({ command: process.execPath, args: [FIXTURE], env });

describe("spawnAcp", () => {
  test("talks ACP to a real subprocess and kills its group", async () => {
    const updates: string[] = [];
    const app = acp.client({ name: "t" }).onNotification(acp.methods.client.session.update, (c) => {
      const u = c.params.update;
      if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") updates.push(u.content.text);
    });
    const link = spawnAcp(app, launch({ ACP_ECHO_STDERR: "hello from stderr" }), process.cwd(), "t");
    const ctx = link.conn.agent;
    const init = await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION });
    expect(init.protocolVersion).toBe(acp.PROTOCOL_VERSION);
    const s = await ctx.request(acp.methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
    const res = await ctx.request(acp.methods.agent.session.prompt, {
      sessionId: s.sessionId,
      prompt: [{ type: "text", text: "ping" }],
    });
    expect(res.stopReason).toBe("end_turn");
    expect(updates).toEqual(["echo: ping"]);
    const t0 = Date.now();
    await link.kill();
    expect(Date.now() - t0).toBeLessThan(2000);
    const exit = await link.exited;
    expect(exit.signal).toBe("SIGTERM");
  }, 15_000);

  test("a pending request fails when the process dies, and SIGKILL follows an ignored SIGTERM", async () => {
    const app = acp.client({ name: "t" });
    const link = spawnAcp(app, launch({ ACP_ECHO_IGNORE_TERM: "1" }), process.cwd(), "t");
    const ctx = link.conn.agent;
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION });
    const s = await ctx.request(acp.methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
    const pending = ctx.request(acp.methods.agent.session.prompt, {
      sessionId: s.sessionId,
      prompt: [{ type: "text", text: "hang" }],
    });
    const t0 = Date.now();
    await link.kill();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2900);
    await expect(pending).rejects.toThrow(/closed|exited/);
    const exit = await link.exited;
    expect(exit.signal).toBe("SIGKILL");
    expect(link.exitInfo()).toMatch(/exited \(signal SIGKILL\)/);
  }, 15_000);

  test("a command that cannot be spawned resolves exited instead of crashing the daemon", async () => {
    const link = spawnAcp(
      acp.client({ name: "t" }),
      { command: "/definitely/not/here", args: [], env: {} },
      process.cwd(),
      "t",
    );
    const exit = await link.exited;
    expect(exit.code).toBeNull();
    await expect(
      link.conn.agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION }),
    ).rejects.toThrow();
  });
});
