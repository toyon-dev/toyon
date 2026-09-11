import { routeKey } from "@toyon/shared";

/** How long a page has to stay before it counts. A login redirect or an auth callback passes
 * through in well under this, and those are pages nobody chose. */
export const VISIT_DWELL_MS = 1500;

export interface Timers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Turns a preview's navigation reports into visits for the route bar's list. A page counts once it
 * has held for VISIT_DWELL_MS, and not again until another page has: a reload, an HMR update or an
 * app rewriting its query on scroll lands on the same key and sends nothing. Kept per frame, since
 * every worktree's preview navigates on its own. */
export class VisitTracker {
  private frames = new Map<string, { sent: string | null; timer: unknown }>();

  constructor(
    private send: (worktreeId: string, path: string) => void,
    private timers: Timers = realTimers,
  ) {}

  note(worktreeId: string, url: string): void {
    let frame = this.frames.get(worktreeId);
    if (!frame) {
      frame = { sent: null, timer: null };
      this.frames.set(worktreeId, frame);
    }
    if (frame.timer !== null) {
      this.timers.clear(frame.timer);
      frame.timer = null;
    }
    const key = routeKey(url);
    if (!key || key === frame.sent) return;
    const f = frame;
    f.timer = this.timers.set(() => {
      f.timer = null;
      f.sent = key;
      this.send(worktreeId, key);
    }, VISIT_DWELL_MS);
  }

  dispose(): void {
    for (const f of this.frames.values()) if (f.timer !== null) this.timers.clear(f.timer);
    this.frames.clear();
  }
}
