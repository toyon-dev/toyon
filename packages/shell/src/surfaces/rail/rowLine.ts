import { isLead, isOwned, type ShipOp, type WorktreeStatus } from "@toyon/shared";
import { dollars } from "../chat/usage.ts";
import { lastStopLine, prLine, recapLine } from "../recap.ts";
import { type DotState, dotClass, isBusy, shipLabel, stateLabel } from "../util.ts";

/**
 * The line under a row's name on a screen.
 *
 * It says what the row's tip says on a desk, where a hover is free. A touch screen never fires one,
 * so a row that keeps this to itself leaves the phone a column of names and dots, which is less
 * than the list it was opened to read. A pure function, the way the rail walk and the recap decide
 * a choice like this: the order below is the whole logic, and it is what the test holds.
 *
 * The socket wins over everything, because nothing further is known. A found worktree runs nothing
 * of ours, so what it can say is where it is, or who is holding it. The lead is where new work
 * starts and its dot describes procs a phone never previews, so it says what a tap on it does. Then what
 * is happening now outranks what happened last: while a turn is running, waiting on you or broken,
 * the previous turn's sentence is about something already over, and next to a working dot it reads
 * as the current state. With nothing in flight the recap is the line worth having, since it is the
 * agent's own account of what it did, where the state is a word the dot already carries.
 */

/** what every row and the panel's ground say while the socket is down */
export const OFFLINE_LINE = "Lost the daemon; retrying";

/** a found worktree's state: git knows it, and nothing of ours runs there */
export const FOUND_LINE = "Not run by Toyon";

/** what the lead's tap does, the verb the desk shows on hover */
const LEAD_LINE = "new worktree";

/** the dots that mean something is happening, or has broken, right now */
const IN_FLIGHT: ReadonlySet<DotState> = new Set(["waiting", "working", "starting", "failed", "crashed"]);

export interface RowContext {
  offline: boolean;
  /** the row's repo has no confirmed config, which is the one idle the dot cannot explain */
  needsSetup: boolean;
  /** where the row is, as the person wrote it (a ~ for home) */
  path: string;
  /** how long since someone last sent here, when the line is to carry it: on a screen the control
   * column that held the time on a desk is gone, and the time reads better after the state than
   * stacked in a column beside the counts */
  at?: string;
  /** the git op the row's dot slot is showing as a spinner (`shipShown`), if one is out */
  op?: ShipOp | null;
}

export function rowLine(w: WorktreeStatus, ctx: RowContext): string {
  if (ctx.offline) return OFFLINE_LINE;
  if (!isOwned(w)) return w.locked ? `Held by ${w.lockReason ?? "another tool"}` : ctx.path;
  // the spinner in the dot's slot is the line's subject; the lead too, since a pull runs there
  if (ctx.op) return shipLabel(ctx.op);
  if (isLead(w.worktree)) return LEAD_LINE;
  const state = stateLabel(w, ctx.needsSetup);
  const turn = w.worktree.lastTurn;
  // a recap carries its own time ("Finished 4h ago.") or is the agent's sentence, which the time
  // would trail after a clamp; the state is a word, and the time is what makes it a line
  if (!IN_FLIGHT.has(dotClass(w)) && turn) return recapLine(turn);
  return ctx.at ? `${state} · ${ctx.at}` : state;
}

/**
 * The lines under the state in an owned row's card on a desk: where the work stands, so a hover
 * is enough to decide whether to switch. The recap first, since it says what the work is; on a
 * busy row the record's recap is the previous stop's, so it is marked and dated there, or under
 * "Agent working" it would read as the turn in flight. Then where the PR stands, when one is out
 * and the branch has not landed since: the composer's own line for it, which is the fact the rail
 * cannot show and the one that decides whether the row needs a hand. The branch is not among
 * them: it is the title's slug on nearly every row, and the menu has it for copying.
 */
export function cardLines(w: WorktreeStatus & { worktree: NonNullable<WorktreeStatus["worktree"]> }): string[] {
  const turn = w.worktree.lastTurn;
  const recap = turn ? (isBusy(w) ? lastStopLine : recapLine)(turn) : undefined;
  const pr = w.worktree.pr && !w.worktree.landed ? prLine(w.worktree.pr) : undefined;
  return [recap, pr].filter((l): l is string => !!l);
}

/** context in use past this share of the window is a figure worth a hover: below it the number
 * changes nothing you would do here */
export const CONTEXT_HIGH = 0.5;

/**
 * The figures at the card's foot, the cost last at the far edge: what the agent has spent here,
 * which the row never shows, so the figures are found in one place. Context only once it runs
 * high, as the composer's ring says it, since "95k of 1000k" is noise and "72% of context" is
 * the cue to start fresh rather than send another turn. Messages waiting behind a turn, when
 * any are: nothing on the rail says a busy row has more queued. Nothing at all when none apply,
 * so the card has no rule over an empty line.
 */
export function cardFigures(w: WorktreeStatus): string[] | undefined {
  const u = w.usage;
  const share = u && u.size > 0 ? u.used / u.size : 0;
  const figures = [
    share >= CONTEXT_HIGH ? `${Math.round(100 * share)}% of context` : undefined,
    w.queued ? `${w.queued} queued` : undefined,
    u?.cost !== undefined ? dollars(u.cost) : undefined,
  ].filter((f): f is string => !!f);
  return figures.length ? figures : undefined;
}
