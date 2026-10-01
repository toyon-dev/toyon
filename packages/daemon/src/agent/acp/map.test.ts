import { describe, expect, test } from "bun:test";
import type { RequestPermissionRequest, RequestPermissionResponse, SessionUpdate } from "@agentclientprotocol/sdk";
import type { AgentEvent } from "@toyon/shared";
import {
  endOfAsk,
  mapCommands,
  mapStopReason,
  mapUpdate,
  summarizeToolOutput,
  type ToolMemos,
  truncate,
} from "./map.ts";

const run = (updates: SessionUpdate[], memos: ToolMemos = new Map()) =>
  updates.flatMap((u) => mapUpdate(u, memos, "t"));

describe("mapUpdate", () => {
  test("message and thought chunks become deltas; non-text blocks are dropped", () => {
    expect(
      run([
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" }, messageId: "m1" },
        { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hm" } },
        { sessionUpdate: "agent_message_chunk", content: { type: "image", data: "", mimeType: "image/png" } },
        { sessionUpdate: "user_message_chunk", content: { type: "text", text: "me" } },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "!" }, messageId: null },
      ]),
    ).toEqual([
      { type: "text-delta", text: "hi", messageId: "m1" },
      { type: "thinking-delta", text: "hm" },
      { type: "text-delta", text: "!" },
    ]);
  });

  test("a picture in a call's content is handed to the sink and named on the end", () => {
    const written: string[] = [];
    const data = Buffer.from("png!").toString("base64");
    const updates: SessionUpdate[] = [
      { sessionUpdate: "tool_call", toolCallId: "r", title: "Read /tmp/shot.png", kind: "read", status: "pending" },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "r",
        status: "completed",
        content: [
          { type: "content", content: { type: "image", data, mimeType: "image/png" } },
          { type: "content", content: { type: "image", data: "", mimeType: "image/png" } },
        ],
      },
    ];
    const memos: ToolMemos = new Map();
    const events = updates.flatMap((u) => mapUpdate(u, memos, "t", (file) => written.push(file)));
    expect(written).toEqual(["53ec22c455168e29.png"]);
    expect(events.at(-1)).toEqual({
      type: "tool-end",
      toolId: "r",
      output: "",
      isError: false,
      images: [{ file: "53ec22c455168e29.png", mimeType: "image/png", bytes: 4 }],
    });
    // without a sink nobody writes the file, so the end names none
    expect(run(updates).at(-1)).toEqual({ type: "tool-end", toolId: "r", output: "", isError: false });
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
        // the first field closing, with nothing else: a partial input, not yet the call
        { sessionUpdate: "tool_call_update", toolCallId: "c1", title: "Write /a", rawInput: { file_path: "/a" } },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "c1",
          title: "Write /a",
          rawInput: { file_path: "/a", content: "y" },
          content: [],
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
        name: "",
        input: { file_path: "/a" },
        kind: "edit",
        title: "Edit files",
      },
      {
        type: "tool-update",
        toolId: "c1",
        title: "Write /a",
        input: { file_path: "/a", content: "y" },
      },
      { type: "tool-end", toolId: "c1", output: "```diff\n@@ -1,1 +1,2 @@\n-x\n+y\n+z\n```", isError: false },
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
      { type: "tool-start", toolId: "c3", name: "", input: { locations: [] }, kind: "execute", title: "run" },
      { type: "tool-end", toolId: "c3", output: "boom", isError: true },
      { type: "tool-start", toolId: "c4", name: "", input: { locations: [] }, title: "late" },
      { type: "tool-end", toolId: "c4", output: "raw", isError: false },
    ]);
  });

  test("a call still being written when the agent moves on ends there: nothing more comes for it", () => {
    const bash = (toolCallId: string): SessionUpdate => ({
      sessionUpdate: "tool_call",
      toolCallId,
      title: "Terminal",
      kind: "execute",
      status: "pending",
      rawInput: {},
    });
    const start = (toolId: string): AgentEvent => ({
      type: "tool-start",
      toolId,
      name: "",
      input: {},
      kind: "execute",
      title: "Terminal",
    });
    // a message sent mid-turn pre-empts the generation after c1 opened: the agent's answer to it
    // starts with a new call, and c1 never gets an update
    expect(run([bash("c1"), bash("c2")])).toEqual([start("c1"), { type: "tool-end", toolId: "c1" }, start("c2")]);
    // the same, cut off after a field of the input closed (a partial refine the map holds back)
    expect(
      run([
        bash("c3"),
        { sessionUpdate: "tool_call_update", toolCallId: "c3", rawInput: { command: "ls" } },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Instead" } },
      ]),
    ).toEqual([start("c3"), { type: "tool-end", toolId: "c3" }, { type: "text-delta", text: "Instead" }]);
    // two calls in one message: the first's input is in before the second opens, so it stays open
    expect(
      run([
        bash("c4"),
        { sessionUpdate: "tool_call_update", toolCallId: "c4", rawInput: { command: "echo one" }, content: [] },
        bash("c5"),
      ]),
    ).toEqual([start("c4"), { type: "tool-update", toolId: "c4", input: { command: "echo one" } }, start("c5")]);
    // a call with nothing to write is whole on arrival: nothing to cut off
    expect(
      run([
        { sessionUpdate: "tool_call", toolCallId: "c6", title: "Task", kind: "think", status: "pending", rawInput: {} },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "on it" } },
      ]).filter((e) => e.type === "tool-end"),
    ).toEqual([]);
  });

  test("a subagent writing a call is read apart from the main agent, and the other way round", () => {
    const meta = { claudeCode: { parentToolUseId: "task1" } };
    const events = run([
      {
        sessionUpdate: "tool_call",
        toolCallId: "m1",
        title: "Terminal",
        kind: "execute",
        status: "pending",
        rawInput: {},
      },
      // the subagent's stream opens a call of its own while the main agent is still writing m1
      { sessionUpdate: "tool_call", toolCallId: "s1", title: "Read File", kind: "read", rawInput: {}, _meta: meta },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "sub" }, _meta: meta },
      // and the main agent moving on ends only its own
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "main" } },
    ]);
    expect(events.filter((e) => e.type === "tool-end").map((e) => e.toolId)).toEqual(["s1", "m1"]);
    expect(events.map((e) => e.type)).toEqual([
      "tool-start",
      "tool-start",
      "tool-end",
      "tool-delta",
      "tool-end",
      "text-delta",
    ]);
  });

  test("a command sent to the background keeps its row open once the session takes it on, and closes as usual otherwise", () => {
    const started =
      "Command running in background with ID: b1. Output is being written to: /t/claude-501/-wt/s1/tasks/b1.output. You will be notified when it completes.";
    const updates: SessionUpdate[] = [
      {
        sessionUpdate: "tool_call",
        toolCallId: "c1",
        title: "Terminal",
        kind: "execute",
        status: "pending",
        rawInput: { command: "bun run check", run_in_background: true, timeout: 600000 },
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "c1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: started } }],
      },
    ];
    const taken: unknown[] = [];
    const memos: ToolMemos = new Map();
    const events = updates.flatMap((u) =>
      mapUpdate(u, memos, "t", undefined, (toolId, start, input) => {
        taken.push([toolId, start, input]);
        return true;
      }),
    );
    expect(events.map((e) => e.type)).toEqual(["tool-start", "tool-update"]);
    expect(events[1]).toEqual({ type: "tool-update", toolId: "c1", background: true });
    expect(taken).toEqual([
      [
        "c1",
        { taskId: "b1", file: "/t/claude-501/-wt/s1/tasks/b1.output" },
        { command: "bun run check", run_in_background: true, timeout: 600000 },
      ],
    ]);
    // nothing more comes for it on the wire, and the memo says so
    expect(memos.get("c1")?.ended).toBe(true);
    // the session declines (the log is not where it looks for it): the row ends the way any call does
    const declining: ToolMemos = new Map();
    const declined = updates.flatMap((u) => mapUpdate(u, declining, "t", undefined, () => false));
    expect(declined.map((e) => e.type)).toEqual(["tool-start", "tool-end"]);
    expect(declined[1]).toMatchObject({ output: started, isError: false });
    // a command that ran in the foreground is never offered
    const plain: ToolMemos = new Map();
    const foreground = [
      { ...updates[0]!, rawInput: { command: "bun run check" } } as SessionUpdate,
      updates[1]!,
    ].flatMap((u) => mapUpdate(u, plain, "t", undefined, () => true));
    expect(foreground.map((e) => e.type)).toEqual(["tool-start", "tool-end"]);
  });

  test("a command reported completed that exited non-zero is an error (OpenCode marks every call completed)", () => {
    expect(
      run([
        {
          sessionUpdate: "tool_call",
          toolCallId: "c5",
          title: "touch /x",
          kind: "execute",
          status: "completed",
          rawOutput: { output: "touch: /x: Operation not permitted", metadata: { exit: 1 } },
        },
      ]),
    ).toEqual([
      {
        type: "tool-start",
        toolId: "c5",
        name: "",
        input: { locations: [] },
        kind: "execute",
        title: "touch /x",
      },
      { type: "tool-end", toolId: "c5", output: "touch: /x: Operation not permitted", isError: true },
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

  test("usage_update carries the context figures, and the cost only when it is in dollars", () => {
    const events = run([
      { sessionUpdate: "usage_update", used: 42_300, size: 200_000, cost: { amount: 1.03, currency: "USD" } },
      { sessionUpdate: "usage_update", used: 42_300, size: 200_000 },
      { sessionUpdate: "usage_update", used: 1, size: 2, cost: { amount: 9, currency: "EUR" } },
    ]);
    expect(events.map((e) => ({ ...e, ts: 0 }))).toEqual([
      { type: "usage", used: 42_300, size: 200_000, cost: 1.03, ts: 0 },
      { type: "usage", used: 42_300, size: 200_000, ts: 0 },
      { type: "usage", used: 1, size: 2, ts: 0 },
    ]);
  });

  test("a Task and the calls it spawned carry the spawn flag and the parent id", () => {
    expect(
      run([
        {
          sessionUpdate: "tool_call",
          toolCallId: "task1",
          title: "Task",
          kind: "other",
          status: "pending",
          _meta: { claudeCode: { toolName: "Task", subagent: true } },
        },
        {
          sessionUpdate: "tool_call",
          toolCallId: "kid1",
          title: "Read /a",
          kind: "read",
          status: "pending",
          _meta: { claudeCode: { toolName: "Read", parentToolUseId: "task1" } },
        },
      ]),
    ).toEqual([
      {
        type: "tool-start",
        toolId: "task1",
        name: "",
        input: { locations: [] },
        kind: "other",
        title: "Task",
        subagent: true,
      },
      {
        type: "tool-start",
        toolId: "kid1",
        name: "",
        input: { locations: [] },
        kind: "read",
        title: "Read /a",
        parentToolId: "task1",
      },
    ]);
  });

  test("a spawn that returns with its subagent only launched ends detached", () => {
    // the call returns its brief and then the sentence, and a brief outruns the cut on the output
    const brief = "Map the daemon. ".repeat(400);
    const ends = (toolName: string, text: string) =>
      run([
        {
          sessionUpdate: "tool_call",
          toolCallId: "task1",
          title: "Task",
          kind: "think",
          status: "pending",
          rawInput: { description: "Map the daemon", prompt: brief },
          _meta: { claudeCode: { toolName } },
        },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "task1",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text } }],
        },
      ]).at(-1);
    expect(ends("Agent", `${brief}\nAsync agent launched successfully.\nagentId: a1`)).toMatchObject({
      type: "tool-end",
      detached: true,
    });
    // waited on: the call came back with the report
    expect(ends("Agent", "The daemon has three layers.")).not.toHaveProperty("detached");
    // the sentence in what some other call printed says nothing about that call
    expect(ends("Read", "Async agent launched successfully.")).not.toHaveProperty("detached");
  });

  test("codex marks its subagent markers but names no parent, so its rows stay flat", () => {
    expect(
      run([
        {
          sessionUpdate: "tool_call",
          toolCallId: "c1",
          title: "Start subagent reviewer",
          kind: "other",
          status: "pending",
          _meta: { codex: { subagent: { threadId: "t1", path: "a/reviewer", activity: "started" } } },
        },
      ]),
    ).toEqual([
      {
        type: "tool-start",
        toolId: "c1",
        name: "",
        input: { locations: [] },
        kind: "other",
        title: "Start subagent reviewer",
        subagent: true,
      },
    ]);
  });

  test("a bare codex key is not a subagent marker; the marker's own shape is", () => {
    const flags = run([
      { sessionUpdate: "tool_call", toolCallId: "a", title: "x", status: "pending", _meta: { codex: {} } },
      {
        sessionUpdate: "tool_call",
        toolCallId: "b",
        title: "y",
        status: "pending",
        _meta: { codex: { subagent: {} } },
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "c",
        title: "z",
        status: "pending",
        _meta: { codex: { subagent: { threadId: "t1" } } },
      },
    ]);
    expect(flags.map((e) => (e.type === "tool-start" ? [e.toolId, e.subagent] : null))).toEqual([
      ["a", undefined],
      ["b", undefined],
      ["c", true],
    ]);
  });

  test("an update for a call we never saw start keeps its parent", () => {
    expect(
      run([
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "orphan",
          title: "Grep",
          status: "completed",
          _meta: { claudeCode: { toolName: "Grep", parentToolUseId: "task1" } },
        },
      ]),
    ).toEqual([
      {
        type: "tool-start",
        toolId: "orphan",
        name: "",
        input: { locations: [] },
        title: "Grep",
        parentToolId: "task1",
      },
      { type: "tool-end", toolId: "orphan", output: "", isError: false },
    ]);
  });

  test("a subagent's prose goes to the row that spawned it, and its thinking is let go", () => {
    expect(
      run([
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "found it" },
          _meta: { claudeCode: { parentToolUseId: "task1" } },
        },
        {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "hmm" },
          _meta: { claudeCode: { parentToolUseId: "task1" } },
        },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "top level" } },
        { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "mine" } },
      ]),
    ).toEqual([
      { type: "tool-delta", toolId: "task1", text: "found it" },
      { type: "text-delta", text: "top level" },
      { type: "thinking-delta", text: "mine" },
    ]);
  });

  test("Claude's spawn is known by the tool's name, with no flag beside it", () => {
    const flags = run([
      {
        sessionUpdate: "tool_call",
        toolCallId: "a",
        name: "Agent",
        title: "Task",
        kind: "think",
        status: "pending",
        rawInput: {},
        _meta: { claudeCode: { toolName: "Agent" } },
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "b",
        name: "Read",
        title: "Read /a",
        kind: "read",
        status: "pending",
        _meta: { claudeCode: { toolName: "Read" } },
      },
    ]);
    expect(flags.map((e) => (e.type === "tool-start" ? [e.toolId, e.subagent] : null))).toEqual([
      ["a", true],
      ["b", undefined],
    ]);
  });

  test("an agent that stamps no subagent meta gets neither field", () => {
    expect(
      run([{ sessionUpdate: "tool_call", toolCallId: "p", title: "Read", kind: "read", status: "pending" }]),
    ).toEqual([{ type: "tool-start", toolId: "p", name: "", input: { locations: [] }, kind: "read", title: "Read" }]);
  });
});

describe("summarizeToolOutput / truncate / stop reasons", () => {
  test("content wins over rawOutput; object rawOutput picks a known text field, else JSON", () => {
    expect(summarizeToolOutput([{ type: "content", content: { type: "text", text: "c" } }], "raw")).toBe("c");
    expect(summarizeToolOutput([], { formatted_output: "f", output: "o" })).toBe("f");
    expect(summarizeToolOutput([], { n: 1 })).toBe('{\n "n": 1\n}');
    expect(summarizeToolOutput([], undefined)).toBe("");
  });
  test("a picture is the output: the raw result behind it (the same picture as base64) is not printed", () => {
    const image = {
      type: "content" as const,
      content: { type: "image" as const, data: "iVBOR", mimeType: "image/png" },
    };
    const raw = [{ type: "image", source: { type: "base64", data: "iVBOR" } }];
    expect(summarizeToolOutput([image], raw)).toBe("");
    expect(summarizeToolOutput([image, { type: "content", content: { type: "text", text: "1 file" } }], raw)).toBe(
      "1 file",
    );
  });
  test("truncate keeps the head and says how much is missing", () => {
    expect(truncate("x".repeat(4010))).toMatch(/… \(10 more chars\)$/);
  });
  test("cancelled reads as interrupted, others pass through", () => {
    expect(mapStopReason("cancelled")).toBe("interrupted");
    expect(mapStopReason("end_turn")).toBe("end_turn");
  });
});

describe("network asks", () => {
  // the shape the Claude adapter sends: no `name`, the tool's name in the meta and as the title
  const call = (name: string): SessionUpdate => ({
    _meta: { claudeCode: { toolName: name } },
    sessionUpdate: "tool_call",
    toolCallId: "n1",
    title: name,
    kind: "other",
    status: "pending",
    rawInput: { host: "fonts.googleapis.com" },
    content: [],
  });
  const ask = (name = "SandboxNetworkAccess"): RequestPermissionRequest => ({
    sessionId: "s",
    toolCall: { toolCallId: "n1", name, title: "fonts.googleapis.com", kind: "other" },
    options: [
      { optionId: "yes", name: "Yes", kind: "allow_once" },
      { optionId: "no", name: "No", kind: "reject_once" },
    ],
  });
  const chose = (optionId: string): RequestPermissionResponse => ({ outcome: { outcome: "selected", optionId } });

  test("the row reads as the host under the fetch glyph, not as the check's name", () => {
    expect(run([call("SandboxNetworkAccess")])).toEqual([
      {
        type: "tool-start",
        toolId: "n1",
        name: "",
        input: { host: "fonts.googleapis.com" },
        kind: "fetch",
        title: "fonts.googleapis.com",
      },
    ]);
  });

  test("the answer ends the row once: allowed, or refused as an error", () => {
    const memos: ToolMemos = new Map();
    run([call("SandboxNetworkAccess")], memos);
    expect(endOfAsk(ask(), chose("yes"), memos)).toEqual({
      type: "tool-end",
      toolId: "n1",
      output: "allowed",
      isError: false,
    });
    expect(endOfAsk(ask(), chose("yes"), memos)).toBeNull();

    const refused: ToolMemos = new Map();
    run([call("SandboxNetworkAccess")], refused);
    expect(endOfAsk(ask(), chose("no"), refused)).toMatchObject({ output: "refused", isError: true });
    const cancelled: ToolMemos = new Map();
    run([call("SandboxNetworkAccess")], cancelled);
    expect(endOfAsk(ask(), { outcome: { outcome: "cancelled" } }, cancelled)).toMatchObject({ isError: true });
  });

  test("any other request leaves its call to the tool that runs it", () => {
    const memos: ToolMemos = new Map();
    run([call("Bash")], memos);
    expect(endOfAsk(ask("Bash"), chose("yes"), memos)).toBeNull();
    expect(memos.get("n1")?.ended).toBe(false);
  });
});

describe("tool searches", () => {
  // the shape the Claude adapter sends for a ToolSearch: no `name`, the loader's name as the title
  // and in the meta, kind `other`, and the query only in the input update that follows
  const start: SessionUpdate = {
    _meta: { claudeCode: { toolName: "ToolSearch" } },
    sessionUpdate: "tool_call",
    toolCallId: "t1",
    title: "ToolSearch",
    kind: "other",
    status: "pending",
    rawInput: {},
  };
  const input = (query: string): SessionUpdate => ({
    _meta: { claudeCode: { toolName: "ToolSearch" } },
    sessionUpdate: "tool_call_update",
    toolCallId: "t1",
    title: "ToolSearch",
    rawInput: { query, max_results: 2 },
    content: [],
  });

  test("the row is a search named for the loader, saying the tools it asked for once they arrive", () => {
    const memos: ToolMemos = new Map();
    expect(run([start, input("select:WebSearch,WebFetch")], memos)).toEqual([
      { type: "tool-start", toolId: "t1", name: "ToolSearch", input: {}, kind: "search", title: "ToolSearch" },
      {
        type: "tool-update",
        toolId: "t1",
        title: "WebSearch, WebFetch",
        input: { query: "select:WebSearch,WebFetch", max_results: 2 },
      },
    ]);
    expect(memos.get("t1")?.writing).toBe(false);
  });

  test("a keyword query reads as typed", () => {
    expect(run([start, input("  notebook jupyter ")]).at(-1)).toMatchObject({ title: "notebook jupyter" });
  });

  test("until the query is in, the call is being written, so a cut-off one is ended", () => {
    const memos: ToolMemos = new Map();
    run([start], memos);
    expect(memos.get("t1")?.writing).toBe(true);
    expect(run([{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "so" } }], memos)).toEqual([
      { type: "tool-end", toolId: "t1" },
      { type: "text-delta", text: "so" },
    ]);
  });
});

describe("mapCommands", () => {
  test("lifts the hint out of the input, defaults a missing description", () => {
    expect(mapCommands([{ name: "review", description: "look at a PR", input: { hint: "<pr>" } }])).toEqual([
      { name: "review", description: "look at a PR", hint: "<pr>" },
    ]);
    expect(mapCommands([{ name: "ship" } as never])).toEqual([{ name: "ship", description: "" }]);
  });

  test("keeps an MCP name verbatim: the adapter re-expands it on the way back", () => {
    expect(mapCommands([{ name: "mcp:linear:issue", description: "" }])[0]!.name).toBe("mcp:linear:issue");
  });

  test("drops nameless entries and caps a flood", () => {
    expect(mapCommands([{ name: "", description: "" }])).toEqual([]);
    expect(mapCommands([{ name: "x".repeat(200), description: "" }])).toEqual([]);
    const many = Array.from({ length: 400 }, (_, i) => ({ name: `c${i}`, description: "" }));
    expect(mapCommands(many)).toHaveLength(300);
  });

  test("keeps the first of two commands with one name", () => {
    expect(
      mapCommands([
        { name: "review", description: "user" },
        { name: "ship", description: "" },
        { name: "review", description: "project" },
      ]),
    ).toEqual([
      { name: "review", description: "user" },
      { name: "ship", description: "" },
    ]);
  });
});
