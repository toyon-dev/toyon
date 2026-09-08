/** A run of edits on one file arrives as one diff per call, each taken against the whole file at
 * the moment of that call (daemon/agent/acp/diff.ts). Stacked, they print the same neighbourhood
 * once per call: a file created and then adjusted prints itself, then most of itself again. What
 * the row wants once the agent has moved on is the run's net change, and the calls can be composed
 * into one because the daemon generated them with real line numbers, so each patch sits in the
 * previous one's after-coordinates and can be rebased onto the file they all started from.
 *
 * The composition checks itself against the text it already holds and returns null rather than
 * guess, so a diff we did not generate (an agent's own format, a block the daemon truncated
 * mid-line) leaves the row stacking its calls the way it does today. A wrong merge would be worse
 * than a repetitive one: it would say the agent wrote something it never wrote. */

import type { OutputBlock } from "./toolCall.ts";

/** the run's calls as the one change they came to, given what each call printed. A call that wrote
 * anything but a single diff (a note about what it did, a block it could not parse) keeps the row
 * on its calls: the merge speaks for the diffs and has nothing to say for the rest. */
export function netOfCalls(calls: OutputBlock[][]): string | null {
  if (calls.length < 2) return null;
  if (!calls.every((blocks) => blocks.length === 1 && blocks[0]?.diff)) return null;
  return mergeDiffs(calls.map((blocks) => blocks[0]!.text));
}

/** one line of the file as the run left it. `a` is where it sits in the file the run started from,
 * `c` where it sits in the version the next patch will be written against; a line the run added has
 * no `a`, one it deleted has no `c`. Lines no patch has touched are not here at all: the model is
 * only ever the neighbourhoods the patches printed. */
type Row =
  | { kind: "same"; a: number; c: number; text: string }
  | { kind: "add"; c: number; text: string }
  | { kind: "del"; a: number; text: string };

type Mark = " " | "-" | "+";
interface Hunk {
  oldStart: number;
  newStart: number;
  ops: { mark: Mark; text: string }[];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** the run's net change, or null where the calls cannot be composed with certainty. The context
 * matches what the daemon generates with, so a run of one call composes to the diff it already had
 * and a row that holds one call is left exactly as it was. */
export function mergeDiffs(texts: string[], context = 3): string | null {
  let rows: Row[] = [];
  for (const text of texts) {
    const hunks = parsePatch(text);
    if (!hunks) return null;
    const next = apply(rows, hunks);
    if (!next) return null;
    rows = next;
  }
  return rows.some((r) => r.kind !== "same") ? emit(rows, context) : null;
}

function parsePatch(text: string): Hunk[] | null {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  for (const line of text.split("\n")) {
    const at = HUNK.exec(line);
    if (at) {
      cur = { oldStart: Number(at[1]), newStart: Number(at[2]), ops: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) return null;
    const mark = line[0];
    if (mark === " " || mark === "-" || mark === "+") cur.ops.push({ mark, text: line.slice(1) });
    // a blank context line loses its marker to a trailing-whitespace trim somewhere along the way
    else if (line === "") cur.ops.push({ mark: " ", text: "" });
    // a `diff --git` header, a "\ No newline", the notice the daemon leaves where it cut the output
    // short: each of them means this block is not one file's hunks, which is all this composes
    else return null;
  }
  return hunks.length > 0 ? hunks : null;
}

/** rebase one patch onto the run so far. The patch is written against the current version, which is
 * `c` on the rows we hold and unknown between them; every line it touches it also prints, so a line
 * we have not seen before can be taken from the patch itself and placed by the offset between the
 * two versions at that point. */
function apply(rows: Row[], hunks: Hunk[]): Row[] | null {
  const out: Row[] = [];
  let i = 0;
  /** a - c for a current line we do not hold: what the patch's own text has to be placed by */
  let delta = 0;
  /** c(next version) - c(current), from the hunks already applied: what carries the rows between
   * hunks forward */
  let shift = 0;
  let upto = 0;

  // a row we pass moves the offset whether or not this patch touched it: the offset describes the
  // current version, and the patch is what turns that into the next one
  const passed = (row: Row) => {
    if (row.kind === "same") delta = row.a - row.c;
    else if (row.kind === "add") delta -= 1;
    else delta += 1;
  };
  /** a line the run already deleted holds no place in the version this patch is written against, so
   * it is stepped over rather than matched, and it keeps the position it was deleted from: ahead of
   * the line that follows it, which is where a diff prints a deletion. */
  const carryDeletions = () => {
    while (i < rows.length && rows[i]!.kind === "del") {
      out.push(rows[i]!);
      passed(rows[i]!);
      i++;
    }
  };
  /** where the next line this patch can name actually sits */
  const nextAt = (from: number): number => {
    for (let k = from; k < rows.length; k++) {
      const row = rows[k]!;
      if (row.kind !== "del") return row.c;
    }
    return Number.POSITIVE_INFINITY;
  };

  for (const h of hunks) {
    // hunks arrive in file order; anything else means these are not one file's diff
    if (h.oldStart <= upto) return null;
    while (i < rows.length) {
      const row = rows[i]!;
      if ((row.kind === "del" ? nextAt(i) : row.c) >= h.oldStart) break;
      out.push(row.kind === "del" ? row : { ...row, c: row.c + shift });
      passed(row);
      i++;
    }
    let c = h.oldStart;
    let n = h.newStart;
    for (const op of h.ops) {
      carryDeletions();
      if (op.mark === "+") {
        out.push({ kind: "add", c: n, text: op.text });
        n++;
        continue;
      }
      const held = rows[i];
      const row = held && held.kind !== "del" && held.c === c ? held : undefined;
      if (row) {
        // the patch quotes the line it is acting on; if it disagrees with what we hold, one of the
        // two is not describing this file and the whole composition is off
        if (row.text !== op.text) return null;
        i++;
        passed(row);
        if (op.mark === " ") out.push({ ...row, c: n });
        // a line the run added and this patch removed was never in the file: it cancels rather than
        // reading as a deletion of something that was there
        else if (row.kind === "same") out.push({ kind: "del", a: row.a, text: row.text });
      } else if (op.mark === " ") {
        out.push({ kind: "same", a: c + delta, c: n, text: op.text });
      } else {
        out.push({ kind: "del", a: c + delta, text: op.text });
      }
      if (op.mark === " ") n++;
      c++;
    }
    shift = n - c;
    upto = c - 1;
  }
  for (; i < rows.length; i++) {
    const row = rows[i]!;
    out.push(row.kind === "del" ? row : { ...row, c: row.c + shift });
  }
  return out;
}

/** the model back out as a unified diff: runs of changed lines with the context we hold around
 * them. Context is what we were given rather than what we ask for, since the lines between two
 * patches' neighbourhoods were never printed to us; a run that ends at the edge of what we hold
 * ends there. */
function emit(rows: Row[], context: number): string {
  const out: string[] = [];
  for (const seg of segments(rows)) {
    for (const [from, to] of runs(seg.rows, context)) {
      const body = sided(seg.rows.slice(from, to));
      const oldCount = body.filter((r) => r.kind !== "add").length;
      const newCount = body.filter((r) => r.kind !== "del").length;
      // each side's first line is where that side of the hunk starts; a hunk that is all additions
      // has no line on the old side, and takes the position it was inserted at
      const oldAt = body.find((r) => r.kind !== "add");
      const newAt = body.find((r) => r.kind !== "del");
      out.push(
        `@@ -${oldAt ? oldAt.a : seg.oldAt[from]},${oldCount} +${newAt ? newAt.c : seg.newAt[from]},${newCount} @@`,
        ...body.map((r) => `${r.kind === "add" ? "+" : r.kind === "del" ? "-" : " "}${r.text}`),
      );
    }
  }
  return out.join("\n");
}

/** each stretch of changed lines with its deletions before its additions. The calls composed a
 * rewrite one line at a time, which would print as alternating bands; a diff puts the old side
 * first, and it is also what lets the chat pair the two runs off against each other to mark the
 * words that actually differ (markWords in toolCall.ts). */
function sided(body: Row[]): Row[] {
  const out: Row[] = [];
  for (let k = 0; k < body.length; ) {
    if (body[k]!.kind === "same") {
      out.push(body[k]!);
      k++;
      continue;
    }
    let end = k;
    while (end < body.length && body[end]!.kind !== "same") end++;
    const run = body.slice(k, end);
    out.push(...run.filter((r) => r.kind === "del"), ...run.filter((r) => r.kind === "add"));
    k = end;
  }
  return out;
}

/** the rows in stretches that are actually contiguous in the file. Two rows sit next to each other
 * in the model whenever no patch printed what is between them, which can be one line or four
 * hundred, so a stretch ends wherever the numbering skips. */
function segments(rows: Row[]): { rows: Row[]; oldAt: number[]; newAt: number[] }[] {
  const segs: { rows: Row[]; oldAt: number[]; newAt: number[] }[] = [];
  let cur: { rows: Row[]; oldAt: number[]; newAt: number[] } | null = null;
  let a = 1;
  let c = 1;
  for (const row of rows) {
    const oldAt = row.kind === "add" ? a : row.a;
    const newAt = row.kind === "del" ? c : row.c;
    if (!cur || oldAt !== a || newAt !== c) {
      cur = { rows: [], oldAt: [], newAt: [] };
      segs.push(cur);
    }
    cur.rows.push(row);
    cur.oldAt.push(oldAt);
    cur.newAt.push(newAt);
    a = oldAt + (row.kind === "add" ? 0 : 1);
    c = newAt + (row.kind === "del" ? 0 : 1);
  }
  return segs;
}

/** the slices of one stretch worth printing: every run of changed lines, with up to `context`
 * unchanged ones each side. Two runs closer than twice that share a slice, or the context between
 * them would print twice. */
function runs(rows: Row[], context: number): [number, number][] {
  const out: [number, number][] = [];
  let k = 0;
  while (k < rows.length) {
    if (rows[k]!.kind === "same") {
      k++;
      continue;
    }
    let end = k;
    let j = k;
    while (j < rows.length) {
      if (rows[j]!.kind !== "same") {
        end = j;
        j++;
        continue;
      }
      let run = 0;
      while (j + run < rows.length && rows[j + run]!.kind === "same") run++;
      if (run > context * 2 || j + run >= rows.length) break;
      j += run;
    }
    out.push([Math.max(0, k - context), Math.min(rows.length, end + context + 1)]);
    k = end + context + 1;
  }
  return out;
}
