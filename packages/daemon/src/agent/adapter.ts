// What the rest of the daemon needs from an agent session. AcpSession (agent/acp/session.ts) is
// the implementation; tests use a fake.

import type {
  AgentCommand,
  AgentEvent,
  AgentStatus,
  AskAnswer,
  Asked,
  AttachmentInput,
  QueuedMessage,
} from "@toyon/shared";

/** what a message sent on another agent's behalf records beside its text: the plan this
 * worktree was born with, or a piece of another chat's work sent into this one (events.ts
 * `handed`), with the text and the stamp the session adds */
export type Handed = Omit<Extract<AgentEvent, { type: "handed" }>, "type" | "text" | "ts" | "attachments">;

/** a login the agent's own CLI runs in a terminal */
export interface LoginRun {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** what a login attempt needs from the caller next */
export type AuthOutcome =
  /** run this as the worktree's login stream; `loggedIn` once it exits cleanly */
  | { kind: "terminal"; run: LoginRun }
  /** the adapter did it; the refused message has been sent again */
  | { kind: "done" };

/** how a person answered an ask card. `answers` absent means they skipped the questions, which
 * the agent is told about rather than being cut off mid-turn. A choice's `note` is what was typed
 * beside the pick; the request it answers takes the option alone, so the note goes to the agent
 * as a message behind it. */
export type AskReply = { kind: "answers"; answers?: AskAnswer[] } | { kind: "choice"; choiceId: string; note?: string };

/** what was attached to the card an answer closes. An elicitation's answer carries only words,
 * so the pictures follow it into the turn as a message of the person's own, right behind it. */
export interface FollowUp {
  attachments: AttachmentInput[];
}

/** which model a side question may run on. `require` asks only on the agent's quick model, for a
 * question that would rather go unasked than spend what the chat's model costs; `prefer` falls back
 * to the agent's default, for one whose answer is still wanted. */
export type Quick = "require" | "prefer";

export interface AskOpts {
  quick?: Quick;
  /** how long to wait for the answer; past it the question is withdrawn and the answer is null.
   * Unset waits as long as the adapter takes. */
  timeoutMs?: number;
}

/** everything a message carries besides its text */
export interface SendOpts {
  /** what Toyon attaches behind the text, paragraph by paragraph; the session wraps them with its
   * own into the one block the transcript never shows */
  context?: string[];
  /** in the order they were attached, which is the order the prompt carries them in */
  attachments?: AttachmentInput[];
  /** the message is Toyon's own, sent for this reason, and the transcript records it as such */
  asked?: Asked;
  /** a message sent on from another chat (a piece of its plan): it answers no card here, so an
   * open one stays open and the message waits behind it */
  keepCards?: true;
  /** the message is sent on another agent's behalf: the pointer at a plan this worktree was born
   * with, or a piece of another chat's work. Recorded as `handed`, which the chat draws as Toyon's
   * row and never as the person's words, and never as queued. */
  handed?: Handed;
}

export interface AgentAdapter {
  readonly status: AgentStatus;
  /** a stop was pressed and the turn it was for has not ended: the status stays busy meanwhile */
  readonly stopping: boolean;
  /** rows held open past the turn for something still going under an idle agent: commands sent
   * to the background and running, wakeups booked and not yet back from. The rail reads it as
   * the worktree not being done, and the runtime as busy: the machine stays awake and the
   * worktree is not put to sleep for it. */
  readonly holding: number;
  /** the earliest wakeup booked, as a time, or null while none is */
  readonly wakes: number | null;
  readonly queueLength: number;
  /** the waiting messages the shell draws as queued: those not yet shown in the transcript */
  readonly queueItems: QueuedMessage[];
  /** a message of the person's is still owed a turn: queued, steered or refused. An open card is
   * not counted: `status` says `waiting`, and the card is a state the shell brings back */
  readonly unsettled: boolean;
  /** notified whenever the pending queue changes (send/consume/unqueue/stop) */
  onQueueChange: (() => void) | null;
  /** the slash commands this worktree's session advertises; empty until the agent has run once */
  readonly commands: AgentCommand[];
  /** notified when that list changes: session start, and any change the agent reports after */
  onCommandsChange: ((commands: AgentCommand[]) => void) | null;
  /** start the session early so `commands` exists before the first message; best effort */
  warmCommands(): Promise<void>;
  /** start the session now, under the worktree's agent, so the first message meets a process
   * that is already up; idle, the reaper takes it back as usual. Best effort. */
  warm(): Promise<void>;
  /** the registry id of the agent whose process is up, or null while none is */
  readonly runningAgent: string | null;
  /** whether the agent's live session was given Toyon's own tools (the handoff tool over MCP):
   * null until a process is up and has said what it takes, so a caller can warm it first */
  readonly mcpTools: boolean | null;
  /** the process group of the adapter up, from its spawn until it is gone, for the ledger the next
   * daemon reclaims from; null while none is */
  readonly pgid: number | null;
  /** drop the process, keeping the session id and the transcript: the next message spawns the
   * agent the record names now */
  restart(): Promise<void>;
  /** the worktree's mode changed: an agent that is up is put in it now, a turn running or not,
   * so a message steered into that turn is answered in the new mode. One that is not up gets it
   * before its next prompt as always; nothing is spawned for it. */
  modeChanged(): void;
  /** context (live-page state) reaches the prompt but never the visible transcript */
  send(text: string, opts?: SendOpts): void;
  /** hold the queue: a message sent meanwhile waits in it, drawn as queued, rather than start a
   * turn while a landing op is moving the tree under the agent. Holds nest; the last release
   * starts what waited. */
  hold(): () => void;
  /** interrupt the running turn; anything queued goes next */
  stop(): void;
  /** `index` is a position in `queueItems`. `taken` is handed the message as it leaves the queue,
   * while its uploads are still held: a message taken back to be changed goes to its box there. */
  unqueue(index: number, taken?: (message: QueuedMessage) => void): void;
  transcript(): Array<{ seq: number; event: AgentEvent }>;
  /** put an event the daemon produced itself (a command the person ran from the composer) on the
   * worktree's transcript and stream, in sequence with what the agent is saying */
  note(event: AgentEvent): void;
  /** one question on a side session (its own system prompt, no chat behind it): the reply text, or
   * null. Spawns the agent if it is not running; never touches the worktree's transcript. */
  ask(system: string, prompt: string, opts?: AskOpts): Promise<string | null>;
  /** log in with one of the methods the agent offered (see the agent-auth-required event) */
  authenticate(methodId: string, apiKey?: string): Promise<AuthOutcome>;
  /** send the message that was refused for want of credentials again */
  retry(): void;
  /** a terminal login finished cleanly: the card closes and the refused message goes again */
  loggedIn(): void;
  /** answer (or skip) an open ask card. An id that already settled is a no-op: two shells can
   * be watching the same worktree, and the other one may have answered first. */
  answer(askId: string, reply: AskReply, followUp?: FollowUp): void;
  /** a card nobody answered for the idle window: it closes as expired and the process goes, the
   * session kept, so the row can sleep like any other. The next message resumes the agent with
   * the question still in its context, so an answer typed then reads as the answer. A handoff
   * card stays: no process waits on it, and declining a plan is the person's to do. */
  lapse(why: string): Promise<void>;
  /** the worktree (or the daemon) is going away: stop the turn and kill the agent's process */
  close(): Promise<void>;
}
