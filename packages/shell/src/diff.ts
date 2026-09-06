// Minimal line diff for the M1 diff view (Monaco replaces this in M2).
// LCS over lines with a size guard; falls back to whole-file replace.

export type DiffLine = { kind: "add" | "del" | "ctx" | "hunk"; text: string };

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > 4_000_000) {
    return [
      { kind: "hunk", text: "@@ file replaced (too large to diff) @@" },
      ...a.map((t) => ({ kind: "del" as const, text: t })),
      ...b.map((t) => ({ kind: "add" as const, text: t })),
    ];
  }

  // LCS table (rows: a, cols: b)
  const m = a.length,
    n = b.length;
  const dp = new Uint32Array((m + 1) * (n + 1));
  const at = (i: number, j: number) => dp[i * (n + 1) + j]!;
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i * (n + 1) + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }

  const raw: DiffLine[] = [];
  let i = 0,
    j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      raw.push({ kind: "ctx", text: a[i]! });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      raw.push({ kind: "del", text: a[i]! });
      i++;
    } else {
      raw.push({ kind: "add", text: b[j]! });
      j++;
    }
  }
  while (i < m) {
    raw.push({ kind: "del", text: a[i]! });
    i++;
  }
  while (j < n) {
    raw.push({ kind: "add", text: b[j]! });
    j++;
  }

  // collapse long runs of context into hunk separators
  const out: DiffLine[] = [];
  const CTX = 3;
  for (let k = 0; k < raw.length; k++) {
    const line = raw[k]!;
    if (line.kind !== "ctx") {
      out.push(line);
      continue;
    }
    let run = 0;
    while (raw[k + run]?.kind === "ctx") run++;
    if (run <= CTX * 2 + 1) {
      for (let r = 0; r < run; r++) out.push(raw[k + r]!);
    } else {
      for (let r = 0; r < CTX; r++) out.push(raw[k + r]!);
      out.push({ kind: "hunk", text: `⋯ ${run - CTX * 2} unchanged lines ⋯` });
      for (let r = run - CTX; r < run; r++) out.push(raw[k + r]!);
    }
    k += run - 1;
  }
  return out;
}
