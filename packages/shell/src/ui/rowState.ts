/**
 * Row state, as the data attribute a stylesheet reads. Three orthogonal words, each answering a
 * different question:
 *
 *   current   the pane beside this row is showing it: the open file, the expanded commit, the
 *             active worktree, the theme kind being previewed
 *   cursor    where the keyboard is, and nothing more: the highlighted picker row, the menu row
 *             the arrows reached
 *   checked   a member of a multi-select: a worktree picked for a fold, an answer chosen
 *
 * A stylesheet reads one with `[data-state~="current"]`, so a row can hold several at once. `on`
 * stays what it is on a Button, a toggle, and never marks a row.
 */
export type RowState = "current" | "cursor" | "checked";

export function rowState(flags: Partial<Record<RowState, boolean | null | undefined>>): string | undefined {
  const held = (Object.keys(flags) as RowState[]).filter((k) => flags[k]);
  return held.length > 0 ? held.join(" ") : undefined;
}
