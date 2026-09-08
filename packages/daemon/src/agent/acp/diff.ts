// ACP hands an edit over as the file before and after, whole. Printing both in full (every old line
// a deletion, every new one an addition) buried a two-line change in four hundred, so the chat cuts
// it to the lines that changed plus a few around them, the way a diff is meant to read.

export type DiffOp = { mark: " " | "-" | "+"; text: string };

/** the middle, after the common ends are trimmed, is diffed properly; past this many cells the DP
 * table is not worth the memory and the middle prints as one replacement */
const MAX_CELLS = 250_000;

export function diffOps(a: string[], b: string[]): DiffOp[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const ops: DiffOp[] = a.slice(0, head).map((text) => ({ mark: " " as const, text }));
  ops.push(...middle(midA, midB));
  ops.push(...a.slice(a.length - tail).map((text) => ({ mark: " " as const, text })));
  return ops;
}

function middle(a: string[], b: string[]): DiffOp[] {
  if (a.length === 0) return b.map((text) => ({ mark: "+", text }));
  if (b.length === 0) return a.map((text) => ({ mark: "-", text }));
  if ((a.length + 1) * (b.length + 1) > MAX_CELLS)
    return [...a.map((text) => ({ mark: "-" as const, text })), ...b.map((text) => ({ mark: "+" as const, text }))];

  // longest common subsequence over lines: table[i][j] is the LCS length of a[i:] and b[j:]
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
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ mark: " ", text: a[i] as string });
      i++;
      j++;
    } else if ((table[(i + 1) * w + j] ?? 0) >= (table[i * w + j + 1] ?? 0)) {
      ops.push({ mark: "-", text: a[i] as string });
      i++;
    } else {
      ops.push({ mark: "+", text: b[j] as string });
      j++;
    }
  }
  while (i < a.length) ops.push({ mark: "-", text: a[i++] as string });
  while (j < b.length) ops.push({ mark: "+", text: b[j++] as string });
  return ops;
}

/** the changed lines with `context` unchanged ones around them, as unified hunks */
export function unifiedDiff(oldText: string, newText: string, context = 3): string {
  const a = oldText === "" ? [] : oldText.split("\n");
  const b = newText === "" ? [] : newText.split("\n");
  const ops = diffOps(a, b);
  // the line each op sits on, so a hunk header can name where it starts
  const oldNo: number[] = [];
  const newNo: number[] = [];
  let o = 1;
  let n = 1;
  for (const op of ops) {
    oldNo.push(o);
    newNo.push(n);
    if (op.mark !== "+") o++;
    if (op.mark !== "-") n++;
  }

  const out: string[] = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k]?.mark === " ") {
      k++;
      continue;
    }
    // the run of changes this hunk covers: two changes closer together than twice the context share
    // a hunk, or their context blocks would print the same lines twice
    const start = k;
    let end = k;
    let j = k;
    while (j < ops.length) {
      if (ops[j]?.mark !== " ") {
        end = j;
        j++;
        continue;
      }
      let run = 0;
      while (j + run < ops.length && ops[j + run]?.mark === " ") run++;
      if (run > context * 2 || j + run >= ops.length) break;
      j += run;
    }
    const from = Math.max(0, start - context);
    const to = Math.min(ops.length, end + context + 1);
    const body = ops.slice(from, to);
    const oldCount = body.filter((op) => op.mark !== "+").length;
    const newCount = body.filter((op) => op.mark !== "-").length;
    out.push(
      `@@ -${oldNo[from]},${oldCount} +${newNo[from]},${newCount} @@`,
      ...body.map((op) => `${op.mark}${op.text}`),
    );
    k = to;
  }
  return out.join("\n");
}
