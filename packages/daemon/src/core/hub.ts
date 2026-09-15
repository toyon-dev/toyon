// Typed, synchronous event hub. Services emit what happened; the WebSocket layer decides what to
// push to which client. Synchronous on purpose: an AcpSession emit runs the hub and then git
// status inline today, and changing that backpressure is a later job, not this file's.

import type { AgentCommand, AgentEvent, AgentStatus, LastTurn, ProcState } from "@toyon/shared";
import { log } from "./log.ts";

export interface HubEvents {
  proc: (worktreeId: string, proc: ProcState) => void;
  log: (worktreeId: string, proc: string, line: string) => void;
  agent: (worktreeId: string, seq: number, event: AgentEvent) => void;
  agentStatus: (worktreeId: string, status: AgentStatus) => void;
  /** the agent stopped (finished, was stopped, failed, or is blocked asking) and the record says how */
  turnSettled: (worktreeId: string, turn: LastTurn) => void;
  queue: (worktreeId: string, items: string[]) => void;
  /** the worktree's agent advertised a new slash-command list */
  agentCommands: (worktreeId: string, commands: AgentCommand[]) => void;
  /** raw output from one of the worktree's streams (its shell or a proc), escapes included */
  termData: (worktreeId: string, stream: string, data: string) => void;
  termExit: (worktreeId: string, stream: string, exitCode: number) => void;
  /** an http request reached the worktree's preview: someone, or something, is using it */
  previewRequest: (worktreeId: string) => void;
  /** outstanding work on the worktree (a turn, a command) started or finished; `count` is what is left */
  holdsChanged: (worktreeId: string, count: number) => void;
  /** the worktree list or any per-worktree status changed */
  worktreesChanged: () => void;
  /** the repo's default branch moved, or a recount was asked for: badges + git-status need refreshing */
  repoTick: (repoId: string) => void;
  /** a repo's config or setup state changed (confirmed, or a settings file edited) */
  reposChanged: () => void;
  /** toyon's own checkout moved under the running daemon, or its `afterLand` started or stopped */
  selfChanged: () => void;
  /** the installed version moved against the running one, or a requested restart's wait changed */
  updateChanged: () => void;
  /** a clone started, moved, finished or failed */
  pendingChanged: () => void;
  themesChanged: () => void;
  /** the default agent (or the registry) changed */
  agentsChanged: () => void;
  /** the order of a repo's most used preview pages changed */
  visitsChanged: (repoId: string) => void;
  /** a worktree's page badges moved: a page was opened, or left */
  pagesChanged: (worktreeId: string) => void;
  /** a worktree of this repo was archived, restored, or deleted from the archive */
  archiveChanged: (repoId: string) => void;
  /** the editor saved or discarded a file: every tab's changes list, and any editor open on it, re-reads */
  filesChanged: (worktreeId: string) => void;
}

type Listener<K extends keyof HubEvents> = HubEvents[K];

export class Hub {
  private listeners = new Map<keyof HubEvents, Set<(...args: never[]) => void>>();

  on<K extends keyof HubEvents>(event: K, fn: Listener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn as (...args: never[]) => void);
    return () => set?.delete(fn as (...args: never[]) => void);
  }

  emit<K extends keyof HubEvents>(event: K, ...args: Parameters<Listener<K>>): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of set) {
      try {
        const r = (fn as (...a: Parameters<Listener<K>>) => unknown)(...args);
        if (r instanceof Promise) r.catch((e) => log.error("hub", `async listener for ${String(event)} rejected`, e));
      } catch (e) {
        // one broken subscriber must not stop the others (or the emitter)
        log.error("hub", `listener for ${String(event)} threw`, e);
      }
    }
  }
}
