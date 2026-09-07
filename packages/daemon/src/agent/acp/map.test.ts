import { describe, expect, test } from "bun:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { mapStopReason, mapUpdate, summarizeToolOutput, type ToolMemos, truncate } from "./map.ts";

const run = (updates: SessionUpdate[], memos: ToolMemos = new Map()) =>
  updates.flatMap((u) => mapUpdate(u, memos, "t"));

describe("mapUpdate", () => {
  test("message and thought chunks become deltas; non-text blocks are dropped", () => {
    expect(
      run([
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
        { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hm" } },
        { sessionUpdate: "agent_message_chunk", content: { type: "image", data: "", mimeType: "image/png" } },
        { sessionUpdate: "user_message_chunk", content: { type: "text", text: "me" } },
      ]),
    ).toEqual([
      { type: "text-delta", text: "hi" },
      { type: "thinking-delta", text: "hm" },
    ]);
  });

  test("tool_call then tool_call_update completed → one start and one end with the merged output", () => {
    const memos: ToolMemos = new Map();
    const events = run(
      [
        {
          sessionUpdate: "tool_call",
          toolCallId: "c1",
          title: "Edit files",
          kind: "edit",
          status: "pending",
          rawInput: { file_path: "/a" },
        },
        { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "in_progress" },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "c1",
          title: "Write /a",
          rawInput: { file_path: "/a", content: "y" },
        },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "c1",
          status: "completed",
          content: [{ type: "diff", path: "/a", oldText: "x", newText: "y\nz" }],
        },
        { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" },
      ],
      memos,
    );
    expect(events).toEqual([
      {
        type: "tool-start",
        toolId: "c1",
        name: "Edit files",
        input: { file_path: "/a" },
        kind: "edit",
        title: "Edit files",
      },
      {
        type: "tool-update",
        toolId: "c1",
        title: "Write /a",
        name: "Write /a",
        input: { file_path: "/a", content: "y" },
      },
      { type: "tool-end", toolId: "c1", output: "--- /a\n-x\n+y\n+z", isError: false },
    ]);
  });

  test("a one-shot completed tool_call, a failed one, and an update before its call", () => {
    expect(
      run([
        {
          sessionUpdate: "tool_call",
          toolCallId: "c2",
          title: "ls",
          name: "Bash",
          kind: "execute",
          status: "completed",
          rawOutput: { stdout: "a\nb" },
        },
        {
          sessionUpdate: "tool_call",
          toolCallId: "c3",
          title: "run",
          kind: "execute",
          status: "failed",
          content: [{ type: "content", content: { type: "text", text: "boom" } }],
        },
        { sessionUpdate: "tool_call_update", toolCallId: "c4", title: "late", status: "completed", rawOutput: "raw" },
      ]),
    ).toEqual([
      { type: "tool-start", toolId: "c2", name: "Bash", input: { locations: [] }, kind: "execute", title: "ls" },
      { type: "tool-end", toolId: "c2", output: "a\nb", isError: false },
      { type: "tool-start", toolId: "c3", name: "run", input: { locations: [] }, kind: "execute", title: "run" },
      { type: "tool-end", toolId: "c3", output: "boom", isError: true },
      { type: "tool-start", toolId: "c4", name: "late", input: { locations: [] }, title: "late" },
      { type: "tool-end", toolId: "c4", output: "raw", isError: false },
    ]);
  });

  test("model config updates surface as session-info; everything else is ignored", () => {
    expect(
      run([
        {
          sessionUpdate: "config_option_update",
          configOptions: [
            { id: "model", name: "Model", category: "model", type: "select", currentValue: "gpt-5", options: [] },
          ],
        },
        { sessionUpdate: "plan", entries: [] },
        { sessionUpdate: "available_commands_update", availableCommands: [] },
        { sessionUpdate: "current_mode_update", currentModeId: "agent" },
      ]),
    ).toEqual([{ type: "session-info", sessionId: "", model: "gpt-5" }]);
  });
});

describe("summarizeToolOutput / truncate / stop reasons", () => {
  test("content wins over rawOutput; object rawOutput picks a known text field, else JSON", () => {
    expect(summarizeToolOutput([{ type: "content", content: { type: "text", text: "c" } }], "raw")).toBe("c");
    expect(summarizeToolOutput([], { formatted_output: "f", output: "o" })).toBe("f");
    expect(summarizeToolOutput([], { n: 1 })).toBe('{\n "n": 1\n}');
    expect(summarizeToolOutput([], undefined)).toBe("");
  });
  test("truncate keeps the head and says how much is missing", () => {
    expect(truncate("x".repeat(4010))).toMatch(/… \(10 more chars\)$/);
  });
  test("cancelled reads as interrupted, others pass through", () => {
    expect(mapStopReason("cancelled")).toBe("interrupted");
    expect(mapStopReason("end_turn")).toBe("end_turn");
  });
});
