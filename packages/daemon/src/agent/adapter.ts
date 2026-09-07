// What the rest of the daemon needs from an agent session. AcpSession (agent/acp/session.ts) is
// the implementation; tests use a fake.

import type { AgentEvent, AgentStatus, PickMeta } from "@toyon/shared";

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
  /** the worktree (or the daemon) is going away: stop the turn and kill the agent's process */
  close(): Promise<void>;
}
