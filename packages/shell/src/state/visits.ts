import { cleanTitle, routeKey } from "@toyon/shared";

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

interface Frame {
  /** the page last counted, and the title it was counted or last renamed with */
  sent: string | null;
  sentTitle?: string;
  /** the page waiting out its dwell */
  pending: string | null;
  /** the document's title as last reported */
  title?: string;
  timer: unknown;
}

/** Turns a preview's navigation reports into visits for the route bar's list. A page counts once it
 * has held for VISIT_DWELL_MS, and not again until another page has: a reload, an HMR update or an
 * app rewriting its query on scroll lands on the same key and sends nothing. Kept per frame, since
 * every worktree's preview navigates on its own.
 *
 * Titles ride along. An app usually names its page after it gets there, so the title a visit carries
 * is whatever the document said last before its dwell ended, and one that changes after the visit
 * was counted goes out as a rename. */
export class VisitTracker {
  private frames = new Map<string, Frame>();

  constructor(
    private send: (worktreeId: string, path: string, title?: string) => void,
    private sendTitle: (worktreeId: string, path: string, title: string) => void,
    private timers: Timers = realTimers,
  ) {}

  /** the preview is at `url`; `title` when the report carried the document's */
  note(worktreeId: string, url: string, title?: string): void {
    const frame = this.frame(worktreeId);
    if (frame.timer !== null) {
      this.timers.clear(frame.timer);
      frame.timer = null;
    }
    frame.pending = null;
    if (title !== undefined) frame.title = cleanTitle(title);
    const key = routeKey(url);
    if (!key) {
      // one of toyon's own pages: nothing to count, and a title from here names no page on the list
      frame.sent = null;
      return;
    }
    if (key === frame.sent) {
      this.renamed(worktreeId, frame);
      return;
    }
    frame.pending = key;
    frame.timer = this.timers.set(() => {
      frame.timer = null;
      frame.pending = null;
      frame.sent = key;
      frame.sentTitle = frame.title;
      this.send(worktreeId, key, frame.title);
    }, VISIT_DWELL_MS);
  }

  /** the document's title changed on its own */
  title(worktreeId: string, title: string): void {
    const frame = this.frame(worktreeId);
    frame.title = cleanTitle(title);
    // a page still waiting out its dwell takes the title with its visit; one already counted is renamed
    if (frame.pending === null) this.renamed(worktreeId, frame);
  }

  dispose(): void {
    for (const f of this.frames.values()) if (f.timer !== null) this.timers.clear(f.timer);
    this.frames.clear();
  }

  private frame(worktreeId: string): Frame {
    let frame = this.frames.get(worktreeId);
    if (!frame) {
      frame = { sent: null, pending: null, timer: null };
      this.frames.set(worktreeId, frame);
    }
    return frame;
  }

  private renamed(worktreeId: string, frame: Frame): void {
    if (!frame.sent || !frame.title || frame.title === frame.sentTitle) return;
    frame.sentTitle = frame.title;
    this.sendTitle(worktreeId, frame.sent, frame.title);
  }
}
