// What the wire does not carry, per adapter, and what toyon does about it. Every guess the daemon
// makes about a tool call, every private `_meta` key it reads and every update it drops is a row
// here, with the code that fills the hole and where the fix stands outside toyon. The rows are
// facts about the version registry.ts pins: a bump fails wire.test.ts until `at` moves, which is
// the moment to read each row against the new dist and flip the ones it closed. A site that can
// stand down reads its row through `wireFlags`; one that is the fallback for any agent that sends
// neither says so in `here` and reads nothing.

export interface WireGap {
  /** what the adapter does not send, or sends in a shape of its own, at the version in `at` */
  gap: string;
  /** what toyon does about it, and in which file */
  here: string;
  /** where the fix stands outside toyon: the ask, the issue or PR, or shipped and behind what */
  upstream: string;
  /** still true of the pinned version, so the code named in `here` runs. A row flipped closed
   * stands its site down; the row and the code go once a release has run that way. */
  open: boolean;
}

export interface AdapterWire {
  /** the adapter version the rows were read against; registry.ts pins the same one */
  at: string;
  gaps: Record<string, WireGap>;
}

/** the rows a site reads by name; every other row is read by a person. An adapter with no row
 * under a name is assumed to have the gap, since the daemon's inference is the fallback for any
 * agent that sends neither. */
export interface WireFlags {
  /** nothing says a call started running: the quiet-second release (session.ts holdInput) */
  noStartSignal: boolean;
  /** a call a steer dropped mid-input gets no terminal status: the marking (map.ts preempted) */
  cutCallUnreported: boolean;
  /** a backgrounded command's finish is off the wire: the tail of its output (background.ts) */
  backgroundFinish: boolean;
  /** a model id off the advertised list is refused: the id is left unsent (session.ts applyOption) */
  modelIdOffList: boolean;
}

const FLAG_NAMES = ["noStartSignal", "cutCallUnreported", "backgroundFinish", "modelIdOffList"] as const;

const CLAUDE: AdapterWire = {
  at: "0.95.0",
  gaps: {
    partialInput: {
      gap:
        "A call's input arrives one top-level field at a time, as `tool_call_update`s carrying `rawInput` and " +
        "nothing else, and nothing marks a refine partial or the last one whole. The whole input of a read " +
        "or a plain command arrives the same way.",
      here:
        "map.ts holds the refine (`held`) and sends it with whatever shows the call has moved on: its " +
        "content, a status, the next call, or the quiet second below. The fallback for every agent; no flag.",
      upstream: "Not asked yet. A mark on the last refine, or no partial refines at all, would retire the hold.",
      open: true,
    },
    noStartSignal: {
      gap:
        "Nothing says a call started running: `tool_call` when it is written, then one update with " +
        "`completed` or `failed` when it returns. The `in_progress` beats since 0.95.0 ride Claude Code's " +
        "tool progress, seconds into a long tool, never at the start.",
      here:
        "session.ts holdInput releases a held input after a quiet second, so a running call does not read " +
        "as still being written; the shell counts the oldest open call as the one executing. Flag: the timer.",
      upstream:
        "Owed to agentclientprotocol/claude-agent-acp: a PreToolUse hook sending `in_progress` on the call's " +
        "id (0.95.0 has one, for v2 Edit and Write previews only). Then mapUpdate forwards it as the start " +
        "stamp and the shell shines from it rather than from the head of the batch.",
      open: true,
    },
    cutCallUnreported: {
      gap:
        "A call the steered message pre-empted while its input streamed gets nothing: no status, no update. " +
        "A cancel closes every open call with `failed` since the 0.9x releases; a steer is not a cancel.",
      here:
        "map.ts marks every open call of the main agent's when a steer is injected (`preempted`) and ends a " +
        "marked or still-writing call when the agent's next word or call arrives (`abandoned`, `cut: true` " +
        "on the tool-end). Flag: the marking; the writing check stays as the fallback.",
      upstream:
        "Owed: the report cancel sends, for each tool_use the interrupt dropped. The cancel path shipped it; " +
        "the steer path has not.",
      open: true,
    },
    steerPriority: {
      gap:
        "The adapter picks the SDK priority of a steered message: `now`, which aborts the step the CLI is on " +
        "(since CLI 2.1.286 a foreground tool moves to the background instead), and `later` only while a " +
        "card is open, which waits for the generation after the tool result. Toyon cannot ask for `next`, " +
        "between steps, which is what a message sent mid-turn means.",
      here:
        'session.ts asks for `priority: "next"` under `_meta.steering` on every steer, which 0.95.0 ignores, ' +
        "and sends a card's follow-up (an image, a note, the edited plan) before the card's reply resolves so " +
        "it lands on `later`; until an adapter reads the priority, a message sent mid-turn can still cut a " +
        "running tool call and the agent reads a follow-up in a second reply. No flag: the ask and the " +
        "ordering are harmless once honoured.",
      upstream:
        "Asked upstream twice, agentclientprotocol/claude-agent-acp#1175 and #1350 (the better shape, " +
        "`_meta.steering.priority`), both unreviewed; still `now` at 0.99.1. Back #1350 rather than open a " +
        "third; the toyon fork pin carries its patch until one lands. The steering extension itself says " +
        "nothing about the running step.",
      open: true,
    },
    backgroundFinish: {
      gap:
        "A command sent to the background returns at once with a task id and an output path, and the wire " +
        "never mentions it again.",
      here:
        "background.ts tails the output file into the row and reads the finish off Claude Code's own session " +
        "log, on four strings toyon does not own. Flag: the sink mapUpdate keeps a background row open through.",
      upstream:
        "Shipped: `async_task_spawned`, `async_task_progress`, `async_task_state_update` and " +
        "`_session/async_task/stop`, but only to a client declaring `_meta.jetbrains.air.capabilities` with " +
        "`asyncTasks` at initialize; no AIR-only key reaches any other client. Ask for a neutral capability, " +
        "or declare that meta.",
      open: true,
    },
    wakeupUnreported: {
      gap:
        "A wakeup the agent books for itself (ScheduleWakeup) returns at once with the delay taken, the turn " +
        "ends, and the wire says nothing about the agent being due back, or when; the turn that fires is an " +
        "autonomous one with no link to the call.",
      here:
        "wakeup.ts reads the delay off the call's input, holds the row until the next turn, and lets go a " +
        "grace past the booked time when none came. No flag.",
      upstream:
        "Not asked. The AIR async-task lifecycle is the nearest shape; a booked wakeup as a task with its " +
        "due time would retire the hold.",
      open: true,
    },
    modelIdOffList: {
      gap:
        "`session/set_config_option` throws Invalid value for a model id the picker did not list, before it " +
        "reaches the SDK's setModel, which takes any id. Aliases resolve and the current value passes since " +
        "0.95.0; a free id still does not.",
      here:
        "session.ts applyOption leaves a wanted id the list lacks unsent, and the hub moves a saved id onto " +
        "the listed one or clears it as the list is learned (`listedModel`). Flag: the unsent check.",
      upstream: "Owed: let a value off the list through for the model option. Then the picker offers what was typed.",
      open: true,
    },
    subagentMeta: {
      gap:
        "A subagent's calls stream into the parent session stamped `_meta.claudeCode.parentToolUseId`; the " +
        "spawn flag is set for one client only, so the tool's name (Agent, Task) stands in for it.",
      here: "map.ts spawnOf reads the stamp and the names, and nests the rows under the spawning call. No flag.",
      upstream:
        "The ACP draft for subagent sessions (agent-client-protocol#1992) is the real shape; the adapter " +
        "serves it behind the AIR `nativeSubagentSessions` capability only.",
      open: true,
    },
    rateLimitMeta: {
      gap: 'The account\'s rate-limit windows ride `usage_update._meta["_claude/rateLimit"]`, a private key.',
      here: "ratelimit.ts reads it. No flag: a key that moves is a parse that returns null.",
      upstream: "Interim until the ACP usage RFD gives the windows fields of their own.",
      open: true,
    },
    authStatusMeta: {
      gap:
        "Which credential the agent runs on arrives as `_auth/status_update`, advertised under " +
        "`agentCapabilities._meta.authStatus`, with no request method.",
      here: "authstatus.ts. No flag.",
      upstream: "Interim extension, on both builtin adapters; first-class fields when the RFD lands.",
      open: true,
    },
    steeringMeta: {
      gap:
        "A message into the running turn is `_session/steering`, advertised under `_meta.steering.supported`, " +
        "with `idleBehavior: promptRequired` the one option a client may ask for.",
      here: "steering.ts and session.ts steer. No flag.",
      upstream: "Interim extension, on both builtin adapters.",
      open: true,
    },
    elicitSpelling: {
      gap:
        "AskUserQuestion comes as a form elicitation: one select per question, a free-text companion named " +
        "`question_<n>_custom`, and an option's longer sample parked in a field EnumOption has no slot for.",
      here: "elicit.ts reads the names. No flag.",
      upstream: "The spellings are the adapter's; nothing to ask until forms gain a companion field.",
      open: true,
    },
    droppedUpdates: {
      gap:
        "Updates toyon gets and does not read: `plan` and `plan_update` (the task list), `compaction_update`, " +
        "`current_mode_update` beyond the plan check, `promptSuggestions` under `session_info_update._meta`, " +
        "and the title the adapter generates for the session. `notice` is withheld because toyon does not " +
        "declare `clientCapabilities.session.notices`.",
      here: "map.ts drops them at its default arm; session.ts reads the mode update for plan only. No flag.",
      upstream: "Shipped. Each is daemon work to read, not an ask.",
      open: true,
    },
    steerEchoUnnamed: {
      gap:
        "The adapter keeps the uuid of the message it injected and surfaces nothing of it: no update says " +
        "which words answer the steer, only that one was injected.",
      here:
        "session.ts reads the first tool-start, or a text-delta under a message other than the one the steer " +
        "cut, as the answer (`answered`, `steerMark`); deltas the pre-emption cut off can trail in and clear " +
        "it, so a stop in that window drops the message. No flag.",
      upstream: "Not asked: the echo's uuid on the first update of the answer would retire the guess.",
      open: true,
    },
    textBurstAfterTools: {
      gap:
        "After a tool result, Fable 5.1 and Opus 5.5 open a thinking block, stay silent for as long as the " +
        "reply takes to write, then deliver every text delta inside a few milliseconds. The adapter forwards " +
        "what it gets; the burst is the model's stream. Sonnet 5 and Haiku 4.5 stream.",
      here: "Nothing: toyon cannot stream text it has not been given. No flag.",
      upstream: "Upstream of the adapter, in the CLI or the model. Reporting it is the user's call.",
      open: true,
    },
    thinkingSignatureOnly: {
      gap:
        "The newest models stream signature-only thinking blocks, which the adapter skips, so no " +
        "`agent_thought_chunk` ever comes for them and the model remembers reasoning toyon never saw.",
      here:
        "Nothing: a note an agent says it made mid-turn is checked against the transcript, and a missing " +
        "text-delta means it was thought. No flag.",
      upstream: "Not asked; a summarized thinking display would need the CLI to produce one.",
      open: true,
    },
    noReplayOnResume: {
      gap:
        "`session/load` replays the whole history as ordinary updates, which no gate on the daemon's side can " +
        "tell from fresh ones; `session/resume` replays nothing. All three builtin adapters offer resume.",
      here:
        "session.ts respawns a reaped adapter through resume and gives an agent without it a new session; " +
        "the transcript on disk is what the chat draws from. No flag.",
      upstream: "Nothing to ask; the AIR `loadReplayEnd` marker is the adapter's answer for clients that load.",
      open: true,
    },
    airFence: {
      gap:
        "Served only to a client that declares `_meta.jetbrains.air` at initialize, never to any other: " +
        "async tasks, fork session (`_meta.jetbrains.air.fork`), exact git patches in diffs (`diffPatch`), " +
        "the plan file capability, subagent sessions (`nativeSubagentSessions`), the session index with " +
        "rename and archive, session failures as structured updates, custom instructions, recommended " +
        "config values.",
      here:
        "Nothing is declared, so none of it arrives. The fork is what forking a chat into a new worktree " +
        "would ride on; the patch would replace diff.ts. No flag.",
      upstream: "Ask for the pieces toyon wants as neutral capabilities, or declare the meta and take the lot.",
      open: true,
    },
  },
};

const CODEX: AdapterWire = {
  at: "2.0.1",
  gaps: {
    askBehindFlag: {
      gap:
        "The request_user_input tool is listed outside plan mode only behind a feature flag; without it a " +
        "question that needs a yes ends the turn as prose.",
      here: "registry.ts sends the flag in CODEX_CONFIG. No flag.",
      upstream: "Codex's own default, not the adapter's.",
      open: true,
    },
    noteMeta: {
      gap: "The ask's free-text field is marked `{ questionId, role: 'user_note' }` under a `codex` meta key.",
      here: "elicit.ts reads it. No flag.",
      upstream: "The adapter's spelling; see Claude's elicitSpelling.",
      open: true,
    },
    subagentFlat: {
      gap: "Subagents arrive as lifecycle markers only ('Start subagent x'); no child call is ever tagged.",
      here: "map.ts spawnOf reads the marker as a flag and draws the rows flat. No flag.",
      upstream: "The same subagent sessions draft as Claude's.",
      open: true,
    },
    deviceCodeLogin: {
      gap: "The device-code login is offered only to a client advertising URL elicitation.",
      here:
        "session.ts withholds `elicitation.url` at initialize, so off the laptop Codex logs in with an API " +
        "key. No flag.",
      upstream: "Nothing to ask: a card could take the URL and the code. Daemon work.",
      open: true,
    },
    noDenyList: {
      gap: "No equivalent of the command deny list Claude and OpenCode take, so a push is refused only by policy.",
      here: "policy.ts decides each command instead. No flag.",
      upstream:
        "Codex's permission profile (`permissions` in CODEX_CONFIG) is the candidate; unverified against the " +
        "sandbox policy the adapter sends with each turn.",
      open: true,
    },
    rateLimitPrivate: {
      gap: "No rate-limit figures on `usage_update`; the adapter keeps them to itself.",
      here: "ratelimit.ts reads nothing for it. No flag.",
      upstream: "Not asked; the rail tip shows plan usage for Claude only.",
      open: true,
    },
    steeringMeta: {
      gap: "`_session/steering` as Claude's. What `turn/interrupt` does with a pending steer is unprobed.",
      here: "steering.ts. No flag.",
      upstream: "Interim extension.",
      open: true,
    },
    hollowLoad: {
      gap:
        "`session/load` returns a minimal response, so whether the model still holds the conversation after " +
        "the five-minute reaper is unverified.",
      here: "Nothing yet; the reaper treats Codex like the others. No flag.",
      upstream:
        "Probe first: prompt, wait past the reaper, ask about the first turn. If the context is gone, the " +
        "reaper skips agents whose load is hollow, or the chat marks the boundary.",
      open: true,
    },
    rejectEndsTurn: {
      gap: "The only reject option on a permission request cancels the turn, so a refused out-of-tree edit ends it.",
      here: "The shell shows the turn as blocked by the agent (`agent-blocked`). No flag.",
      upstream: "Not asked; a reject that returns to the model, as Claude's does, is the ask.",
      open: true,
    },
  },
};

const OPENCODE: AdapterWire = {
  at: "1.18.33",
  gaps: {
    exitInMetadata: {
      gap:
        "Every shell call completes, a refused write included; how it went is `rawOutput.metadata.exit` and " +
        "never the status.",
      here: "map.ts exitCodeOf reads it. No flag.",
      upstream: "Not asked; a `failed` status for a non-zero exit would retire the read.",
      open: true,
    },
    modeAsOption: {
      gap: "Modes come as a config option named `mode`, not as ACP's modes.",
      here: "session.ts modeConfigId and options.ts readModeOption. No flag.",
      upstream: "Not asked; ACP v2 makes the mode a config option for every agent, so this is the shape to come.",
      open: true,
    },
    planReviewUnprobed: {
      gap: "How a plan reaches the client for review over ACP has not been probed; Claude's ExitPlanMode card has.",
      here: "Plan mode maps to OpenCode's `plan` mode and nothing reads a plan back. No flag.",
      upstream: "Probe before asking.",
      open: true,
    },
  },
};

/** What the protocol itself lacks, at the SDK version the daemon speaks (`@agentclientprotocol/sdk`
 * in the daemon's package.json), as opposed to what one adapter does with it. */
export const PROTOCOL: AdapterWire = {
  at: "1.4.0",
  gaps: {
    noUpdatedInput: {
      gap:
        "A permission answer carries only the chosen option id, no revised input, so an edited plan cannot go " +
        "back as the approval of something else.",
      here:
        "session.ts approves the plan as it stands and sends the edited file to the agent as a message after " +
        "it. No flag.",
      upstream: "An ask on the spec: `updatedInput` on `RequestPermissionResponse`, as MCP's elicitation has.",
      open: true,
    },
    noCheckpoint: {
      gap: "The Claude SDK checkpoints files per turn; ACP exposes none of it.",
      here: "Discarding a file from the changes list is the rewind; the worktree is the checkpoint. No flag.",
      upstream: "Not asked; the worktree model makes it a small loss.",
      open: true,
    },
    cancelledIsV2: {
      gap:
        "A tool call status of `cancelled` exists on the v2 wire only; v1 reports a dropped call as `failed` " +
        "with a sentence saying it never ran.",
      here: "map.ts reads `failed` as an error and the shell draws the sentence. No flag.",
      upstream: "Comes with the v2 move.",
      open: true,
    },
    v2Blocked: {
      gap:
        "The v2 wire changes the turn model (the prompt answers at once, the end comes as a state update) and " +
        "the Claude adapter's v2 path strips the steering extension; codex-acp speaks v1 only.",
      here:
        "The daemon stays on the stable v1 import, and SDK 2.x still defaults to it. The session's turn " +
        "lifecycle and its tests are written against v1. No flag.",
      upstream:
        "Revisit when the Claude adapter serves steering, or a native equivalent, on v2 and codex-acp is on " +
        "SDK 2.x; then it is a turn-model redesign, not a type migration.",
      open: true,
    },
    commandInputShape: {
      gap:
        "`AvailableCommandInput` is the unstructured variant at this version; v2 widens it to a union keyed " +
        "by `type`.",
      here: "map.ts mapCommands reads `input.hint` directly. No flag.",
      upstream: "Comes with the v2 move; a `type` check first.",
      open: true,
    },
    withheldCapabilities: {
      gap:
        "Capabilities toyon does not declare, so the agent never sends what rides on them: client fs (the " +
        "agent edits with its own tools), a client terminal (terminal content blocks are dropped), URL " +
        "elicitation (a browser mid-turn), `session.notices`, and the AIR meta above.",
      here: "session.ts initialize declares form elicitation and terminal-auth only. No flag.",
      upstream: "Toyon's choice per capability; notices and URL elicitation are the two worth revisiting.",
      open: true,
    },
  },
};

/** the rows per builtin adapter, by agent id */
export const WIRES: Record<string, AdapterWire> = { claude: CLAUDE, codex: CODEX, opencode: OPENCODE };

/** the flags a table yields: a row's `open`, or the gap assumed where the table has no row */
export function flagsOf(wire: AdapterWire | undefined): WireFlags {
  const flags = {} as Record<(typeof FLAG_NAMES)[number], boolean>;
  for (const name of FLAG_NAMES) flags[name] = wire?.gaps[name]?.open ?? true;
  return flags;
}

/** what the daemon still has to infer for this agent */
export function wireFlags(agentId: string): WireFlags {
  return flagsOf(WIRES[agentId]);
}
