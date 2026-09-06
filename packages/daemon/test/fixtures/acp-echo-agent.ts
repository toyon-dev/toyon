// A minimal ACP agent over stdio for the transport test: echoes each prompt as one text chunk.
// ACP_ECHO_IGNORE_TERM=1 makes it shrug off SIGTERM so the SIGKILL path can be exercised.
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

if (process.env.ACP_ECHO_IGNORE_TERM === "1") process.on("SIGTERM", () => {});
if (process.env.ACP_ECHO_STDERR) console.error(process.env.ACP_ECHO_STDERR);

const agent = acp
  .agent({ name: "echo" })
  .onRequest(acp.methods.agent.initialize, () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} }))
  .onRequest(acp.methods.agent.session.new, () => ({ sessionId: "echo-1" }))
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const text = ctx.params.prompt.map((b) => (b.type === "text" ? b.text : "")).join("");
    if (text.includes("hang")) await new Promise(() => {});
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `echo: ${text}` } },
    });
    return { stopReason: "end_turn" };
  })
  .onNotification(acp.methods.agent.session.cancel, () => {});

agent.connect(
  acp.ndJsonStream(
    Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  ),
);
