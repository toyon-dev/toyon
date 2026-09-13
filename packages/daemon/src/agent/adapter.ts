// What the rest of the daemon needs from an agent session. AcpSession (agent/acp/session.ts) is
// the implementation; tests use a fake.

import type { AgentCommand, AgentEvent, AgentStatus, AskAnswer, AttachmentInput } from "@toyon/shared";

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
 * the agent is told about rather than being cut off mid-turn. */
export type AskReply = { kind: "answers"; answers?: AskAnswer[] } | { kind: "choice"; choiceId: string };

/** which model a side question may run on. `require` asks only on the agent's quick model, for a
 * question that would rather go unasked than spend what the chat's model costs; `prefer` falls back
 * to the agent's default, for one whose answer is still wanted. */
export type Quick = "require" | "prefer";

export interface AskOpts {
  quick?: Quick;
}

/** everything a message carries besides its text */
export interface SendOpts {
  context?: string;
  /** in the order they were attached, which is the order the prompt carries them in */
  attachments?: AttachmentInput[];
}

export interface AgentAdapter {
  readonly status: AgentStatus;
  readonly queueLength: number;
  /** the waiting messages the shell draws as queued: those not yet shown in the transcript */
  readonly queueItems: string[];
  /** notified whenever the pending queue changes (send/consume/unqueue/stop) */
  onQueueChange: (() => void) | null;
  /** the slash commands this worktree's session advertises; empty until the agent has run once */
  readonly commands: AgentCommand[];
  /** notified when that list changes: session start, and any change the agent reports after */
  onCommandsChange: ((commands: AgentCommand[]) => void) | null;
  /** start the session early so `commands` exists before the first message; best effort */
  warmCommands(): Promise<void>;
  /** context (live-page state) reaches the prompt but never the visible transcript */
  send(text: string, opts?: SendOpts): void;
  /** interrupt the running turn; anything queued goes next */
  stop(): void;
  /** `index` is a position in `queueItems` */
  unqueue(index: number): void;
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
  answer(askId: string, reply: AskReply): void;
  /** the worktree (or the daemon) is going away: stop the turn and kill the agent's process */
  close(): Promise<void>;
}
