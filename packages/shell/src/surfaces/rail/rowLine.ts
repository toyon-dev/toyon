import {
  type ArchivedWorktree,
  isLead,
  isOwned,
  type ShipOp,
  type TrunkStatus,
  type WorktreeStatus,
} from "@toyon/shared";
import { dollars } from "../chat/usage.ts";
import { originNote } from "../chips/baseNote.ts";
import { ended, lastStopLine, prLine, recapLine, when } from "../recap.ts";
import { ago, type DotState, dotClass, isBusy, shipLabel, stateLabel } from "../util.ts";

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

/**
 * The lines under main's state. Main has no turn and no PR; what a hover on it asks is whether it
 * is fresh, and two facts answer that: what landed on it last, from the newest land mark across
 * the rows and the archive, and where it stands against origin. The origin line is the composer's
 * own note when there is something to say (behind, held back, unreachable), and says level when
 * there is not, since "fetched just now" with no count is the answer being looked for. Nothing
 * about origin when the repo has never fetched one.
 */
export function leadLines(
  worktrees: readonly WorktreeStatus[],
  archived: readonly ArchivedWorktree[],
  trunk: TrunkStatus | null,
  defaultBranch: string,
): string[] {
  let last: { title: string; at: number } | undefined;
  const mark = (title: string, at: number | undefined) => {
    if (at && (!last || at > last.at)) last = { title, at };
  };
  for (const w of worktrees) {
    const lands = w.worktree?.lands;
    if (w.worktree && lands?.length) mark(w.worktree.title, lands[lands.length - 1]?.at);
  }
  for (const a of archived) mark(a.title, a.landedAt);
  const landed = last ? `Landed ${last.title} ${when(ago(last.at))}.` : undefined;
  const note = trunk ? originNote(defaultBranch, trunk) : null;
  const origin = note
    ? ended(`${note.charAt(0).toUpperCase()}${note.slice(1)}`)
    : trunk?.fetchedAt
      ? `Level with origin, fetched ${when(ago(trunk.fetchedAt))}.`
      : undefined;
  return [landed, origin].filter((l): l is string => !!l);
}

/** the longest line an archived row's first message makes: past it the line is cut at a word */
const PROMPT_MAX = 160;

/**
 * The lines under an archived row's state. First the first message sent there, which the record
 * keeps so a row can say what the work was. The last recap would say where the last turn left it,
 * which is not the same thing over a long session; what was asked is true of the whole of it. Then
 * why it archived itself, when it did: the clock in the dot's seat is on the row the card belongs
 * to, and a tip of its own there swapped with the card as the pointer crossed the row.
 */
export function archivedLines(a: ArchivedWorktree): string[] {
  const auto = a.auto ? [`Archived automatically: ${a.auto}`] : [];
  const p = a.prompt?.replace(/\s+/g, " ").trim();
  if (!p) return auto;
  if (p.length <= PROMPT_MAX) return [p, ...auto];
  const cut = p.slice(0, PROMPT_MAX);
  return [`${cut.slice(0, Math.max(cut.lastIndexOf(" "), 1)).trimEnd()}…`, ...auto];
}

/** how many archived rows the rail draws: the ones recent enough to be found by where they sit.
 * Past that a row is found by its name, which is the archive palette's job. */
export const ARCHIVED_SHOWN = 25;

/**
 * The archived rows the rail draws, newest first, and how many it leaves to the palette. The
 * archive only grows, so the rail keeps a fixed window of it. A single row over the measure is
 * drawn, since the row saying "1 more" would take the line it saves. The row whose page is up is
 * always drawn, after the rest when it is older than the window: its page marks a row, and the
 * mark needs one to sit on.
 */
export function archivedWindow(
  archived: readonly ArchivedWorktree[],
  pageId: string | null,
): { shown: readonly ArchivedWorktree[]; rest: number } {
  if (archived.length <= ARCHIVED_SHOWN + 1) return { shown: archived, rest: 0 };
  const shown = archived.slice(0, ARCHIVED_SHOWN);
  const page = pageId ? archived.find((a) => a.id === pageId) : undefined;
  if (page && !shown.includes(page)) shown.push(page);
  return { shown, rest: archived.length - shown.length };
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
