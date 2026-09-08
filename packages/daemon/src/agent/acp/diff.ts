// ACP hands an edit over as the file before and after, whole. Printing both in full (every old line
// a deletion, every new one an addition) buried a two-line change in four hundred, so the chat cuts
// it to the lines that changed plus a few around them, the way a diff is meant to read.

import { diffSeq } from "@toyon/shared";

export type DiffOp = { mark: " " | "-" | "+"; text: string };

export function diffOps(a: string[], b: string[]): DiffOp[] {
  return diffSeq(a, b).map((op) => ({ mark: op.mark, text: op.value }));
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
