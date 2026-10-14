import { realTimers, type Timers } from "../../app/railPeek.ts";

/** How long a drag rests on a row before the row's worktree comes up under it. A drag crossing the
 * strip on its way to the chat is over any one row for far less; a hand that has stopped on a dot
 * is waiting for it, and the row lit as a drop target under it (useFileDrop) says the rest is on
 * its way. Shorter than Finder's spring-loaded folders: the switch here is cheap to undo. */
export const SPRING_HOLD_MS = 350;

/** How long the panel outlives the last sign of the drag over it. A dragleave for a move between
 * two rows is followed by the next row's dragover in the same iteration of the browser's drag
 * loop, so this only elapses when the pointer has really left the rail. */
const GONE_MS = 80;

/** backstop, for a drag that ends with no word to the rail: an escape or a drop elsewhere fires
 * nothing here, and the browser's drag loop stops sending dragover the moment the drag ends */
const IDLE_MS = 2000;

/** The rail under a file drag. The browser delivers no keys while a drag is in flight, so the
 * worktree chords are out of reach and a file meant for another worktree's chat has nowhere to go
 * until the drag is over. The rail answers the drag instead: the strip unfurls as soon as a drag
 * is over it (`hold`), and a row the drag rests on for SPRING_HOLD_MS is landed on, so the drop
 * can go on into that worktree's composer. */
export function createSpringLoad(hold: (on: boolean) => void, timers: Timers = realTimers) {
  let shown = false;
  /** the row the drag is resting on, with the wait that lands on it */
  let armed: { id: string; pending: unknown } | null = null;
  /** the row the drag last landed on: a rest that goes on is not landed on again */
  let landed: string | null = null;
  let gone: unknown = null;
  let idle: unknown = null;
  const disarm = () => {
    if (!armed) return;
    timers.clear(armed.pending);
    armed = null;
  };
  const settle = () => {
    if (gone !== null) timers.clear(gone);
    if (idle !== null) timers.clear(idle);
    gone = null;
    idle = null;
  };
  const end = () => {
    disarm();
    settle();
    landed = null;
    if (!shown) return;
    shown = false;
    hold(false);
  };
  return {
    /** a dragover on the rail: over the row `id`, with what landing on it does, or over nothing to
     * land on (the ground between rows, the row already on screen) */
    over(row: { id: string; land: () => void } | null) {
      settle();
      idle = timers.set(end, IDLE_MS);
      if (!shown) {
        shown = true;
        hold(true);
      }
      if (armed?.id === row?.id) return;
      disarm();
      if (!row || row.id === landed) return;
      landed = null;
      armed = {
        id: row.id,
        pending: timers.set(() => {
          armed = null;
          landed = row.id;
          row.land();
        }, SPRING_HOLD_MS),
      };
    },
    /** a dragleave on the rail: the next dragover, if one is coming, is a beat away. The row stays
     * armed through it: a move from a row's dot to its name is a leave and an over on the same row,
     * and the wait is the hand's rest on the row, not on one span of it. */
    leave() {
      if (!shown) return;
      if (gone !== null) timers.clear(gone);
      gone = timers.set(end, GONE_MS);
    },
    /** the drag is over: dropped, here or anywhere */
    end,
  };
}
