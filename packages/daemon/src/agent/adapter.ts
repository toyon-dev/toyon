// What the rest of the daemon needs from an agent session. AcpSession (agent/acp/session.ts) is
// the implementation; tests use a fake.

import type { AgentEvent, AgentStatus, PickMeta } from "@toyon/shared";

/** what a login attempt needs from the caller next */
export type AuthOutcome =
  /** run this line in the worktree's terminal; the agent's own CLI takes it from there */
  | { kind: "terminal"; line: string }
  /** the adapter did it; the refused message has been sent again */
  | { kind: "done" };

export interface AgentAdapter {
  readonly status: AgentStatus;
  readonly queueLength: number;
  readonly queueItems: string[];
  /** notified whenever the pending queue changes (send/consume/unqueue/stop) */
  onQueueChange: (() => void) | null;
  /** context (live-page state, picked elements) reaches the prompt but never the visible transcript */
  send(text: string, context?: string, pick?: PickMeta): void;
  /** interrupt the running turn and drop anything queued */
  stop(): void;
  unqueue(index: number): void;
  transcript(): Array<{ seq: number; event: AgentEvent }>;
  /** one question on a side session (no tools, its own system prompt): the reply text, or null.
   * Spawns the agent if it is not running; never touches the worktree's transcript. */
  ask(system: string, prompt: string): Promise<string | null>;
  /** log in with one of the methods the agent offered (see the agent-auth-required event) */
  authenticate(methodId: string, apiKey?: string): Promise<AuthOutcome>;
  /** send the message that was refused for want of credentials again */
  retry(): void;
  /** the worktree (or the daemon) is going away: stop the turn and kill the agent's process */
  close(): Promise<void>;
}
