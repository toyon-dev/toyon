// What ← and → do in a list whose rows hold other rows: one rule, so a folder in the files tree, a
// commit in the history, a test file over its names and a tool call in the transcript all answer
// the two keys the same way. Pure: the caller says what its rows are and carries out the move.

/** a row as the two keys see it: how deep it sits, and whether it holds rows of its own. `open` is
 * left out for a row that holds nothing. */
export interface TreeNavRow {
  depth: number;
  open?: boolean;
}

/** what a key asks for: open or close a row (always the one the cursor is on), or move the cursor */
export type TreeMove = { do: "open" | "close" | "to"; at: number };

/**
 * → opens a shut row, and from an open one steps onto the first row inside it. ← closes an open
 * row, and from anything else climbs to the row that holds it. A row with nothing to do (→ on a
 * leaf, ← at the top level) answers null, and the key is still the tree's: it never falls through
 * to whatever is around the list.
 */
export function treeKey(rows: readonly TreeNavRow[], at: number, key: "ArrowLeft" | "ArrowRight"): TreeMove | null {
  const row = rows[at];
  if (!row) return null;
  if (key === "ArrowRight") {
    if (row.open === undefined) return null;
    if (!row.open) return { do: "open", at };
    return (rows[at + 1]?.depth ?? -1) > row.depth ? { do: "to", at: at + 1 } : null;
  }
  if (row.open) return { do: "close", at };
  for (let i = at - 1; i >= 0; i--) if ((rows[i]?.depth ?? 0) < row.depth) return { do: "to", at: i };
  return null;
}
