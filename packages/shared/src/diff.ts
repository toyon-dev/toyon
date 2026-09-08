// Diffing, shared because both ends of an edit need it and it is the same walk: the daemon lines the
// file before up against the file after, the chat lines a run of deleted lines up against the run
// that replaced it so it can tint the words that actually differ.

export type DiffMark = " " | "-" | "+";

export interface DiffOp<T> {
  mark: DiffMark;
  value: T;
}

/** the middle, after the common ends are trimmed, is diffed properly; past this many cells the DP
 * table is not worth the memory and the middle comes back as one replacement */
const MAX_CELLS = 250_000;

/** the ops that turn `a` into `b`: a match on both sides, a deletion, an addition */
export function diffSeq<T>(a: T[], b: T[]): DiffOp<T>[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const ops: DiffOp<T>[] = a.slice(0, head).map((value) => ({ mark: " " as const, value }));
  ops.push(...middle(a.slice(head, a.length - tail), b.slice(head, b.length - tail)));
  ops.push(...a.slice(a.length - tail).map((value) => ({ mark: " " as const, value })));
  return ops;
}

function middle<T>(a: T[], b: T[]): DiffOp<T>[] {
  if (a.length === 0) return b.map((value) => ({ mark: "+", value }));
  if (b.length === 0) return a.map((value) => ({ mark: "-", value }));
  if ((a.length + 1) * (b.length + 1) > MAX_CELLS)
    return [...a.map((value) => ({ mark: "-" as const, value })), ...b.map((value) => ({ mark: "+" as const, value }))];

  // longest common subsequence: table[i][j] is the LCS length of a[i:] and b[j:]
  const w = b.length + 1;
  const table = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * w + j] =
        a[i] === b[j]
          ? (table[(i + 1) * w + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * w + j] ?? 0, table[i * w + j + 1] ?? 0);
    }
  }
  const ops: DiffOp<T>[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ mark: " ", value: a[i] as T });
      i++;
      j++;
    } else if ((table[(i + 1) * w + j] ?? 0) >= (table[i * w + j + 1] ?? 0)) {
      ops.push({ mark: "-", value: a[i] as T });
      i++;
    } else {
      ops.push({ mark: "+", value: b[j] as T });
      j++;
    }
  }
  while (i < a.length) ops.push({ mark: "-", value: a[i++] as T });
  while (j < b.length) ops.push({ mark: "+", value: b[j++] as T });
  return ops;
}

/** a run of one line that the word diff either kept or changed */
export interface Span {
  text: string;
  changed: boolean;
}

/** words, runs of whitespace, and punctuation one character at a time: `metrics[0]` and
 * `metrics_by_id[public_metric.id]` then share the `metrics`, and the brackets line up on their own
 * rather than dragging the identifier around them into the change */
const TOKEN = /[\p{L}\p{N}_$]+|\s+|[^\s\p{L}\p{N}_$]/gu;

export function tokenize(line: string): string[] {
  return line.match(TOKEN) ?? [];
}

/** below this share of characters in common the two lines are different lines, not one line edited:
 * highlighting the odd word they happen to share would say the rest survived when it did not */
const MIN_SIMILARITY = 0.4;

/** which parts of a replacement changed, for both sides at once. Newlines are tokens like any other,
 * so this takes a whole run of deleted lines against the run that replaced it and finds the lines
 * that survived as readily as the words. `null` where the two sides have too little in common to
 * read as an edit of each other, and the caller should mark them changed whole. */
export function wordSpans(before: string, after: string): { before: Span[]; after: Span[] } | null {
  if (before === after) return null;
  const ops = diffSeq(tokenize(before), tokenize(after));
  let kept = 0;
  for (const op of ops) if (op.mark === " ") kept += op.value.length;
  if (kept < MIN_SIMILARITY * Math.max(before.length, after.length)) return null;
  return {
    before: spansOf(ops, "-"),
    after: spansOf(ops, "+"),
  };
}

/** one side of the word diff, with neighbouring tokens of the same state joined so a run of changed
 * words draws as one block rather than a row of them with seams down it */
function spansOf(ops: DiffOp<string>[], side: "-" | "+"): Span[] {
  const spans: Span[] = [];
  for (const op of ops) {
    if (op.mark !== " " && op.mark !== side) continue;
    const changed = op.mark === side;
    const last = spans[spans.length - 1];
    if (last && last.changed === changed) last.text += op.value;
    else spans.push({ text: op.value, changed });
  }
  // the two ways a short span in the middle of a line lies about what happened. Whitespace between
  // two words that both stayed is the gap the line always had, and tinting it draws a bar across the
  // line; a scrap of punctuation between two changes is the bracket the change happened around, not
  // something that survived it, and calling it kept breaks one block into three.
  for (let i = 1; i < spans.length - 1; i++) {
    const span = spans[i];
    if (!span) continue;
    if (span.changed) span.changed = span.text.trim() !== "";
    else span.changed = span.text.length <= 2;
  }
  return merge(spans);
}

/** the spans of a multi-line side, cut back into one list per line. The newlines were tokens like
 * any other, so a line that survived a rewrite comes back with nothing marked on it. */
export function splitSpanLines(spans: Span[]): Span[][] {
  const lines: Span[][] = [[]];
  for (const span of spans) {
    const parts = span.text.split("\n");
    for (const [i, part] of parts.entries()) {
      if (i > 0) lines.push([]);
      if (part) (lines[lines.length - 1] as Span[]).push({ text: part, changed: span.changed });
    }
  }
  return lines.map(merge);
}

function merge(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const span of spans) {
    const last = out[out.length - 1];
    if (last && last.changed === span.changed) last.text += span.text;
    else out.push({ ...span });
  }
  return out;
}
