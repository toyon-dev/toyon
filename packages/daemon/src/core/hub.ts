// Typed, synchronous event hub. Services emit what happened; the WebSocket layer decides what to
// push to which client. Synchronous on purpose: AgentSession.emit → hub → git status runs inline
// today, and changing that backpressure is a later job, not this file's.

import type { AgentEvent, AgentStatus, ProcState } from "@toyon/shared";
import { log } from "./log.ts";

export interface HubEvents {
  proc: (worktreeId: string, proc: ProcState) => void;
  log: (worktreeId: string, proc: string, line: string) => void;
  agent: (worktreeId: string, seq: number, event: AgentEvent) => void;
  agentStatus: (worktreeId: string, status: AgentStatus) => void;
  queue: (worktreeId: string, items: string[]) => void;
  /** raw output from one of the worktree's streams (its shell or a proc), escapes included */
  termData: (worktreeId: string, stream: string, data: string) => void;
  termExit: (worktreeId: string, stream: string, exitCode: number) => void;
  /** the worktree list or any per-worktree status changed */
  worktreesChanged: () => void;
  /** the repo's default branch moved: badges + git-status need refreshing */
  repoTick: (repoId: string) => void;
  /** a repo's config or setup state changed (confirmed, or toyon.json edited) */
  reposChanged: () => void;
  themesChanged: () => void;
  /** the default agent (or the registry) changed */
  agentsChanged: () => void;
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
