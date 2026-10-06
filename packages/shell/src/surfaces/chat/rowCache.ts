import type { ReactElement } from "react";

/**
 * The log's rows, each the element from last render wherever the row would print the same.
 *
 * React passes over a child handed the very same element it had: no props compared, no memo asked,
 * no render. Making a new element for every row on every render costs the transcript's length on
 * every token that lands, in element creation and in the rows' memo comparators, before any row
 * renders. So each row's element is kept with the props it was made from, and handed over again
 * while those are the same, prop by prop.
 */

/** what a row is: which component, and the props it gets */
export interface Row {
  kind: string;
  props: object;
}

export type RowCache<R extends Row> = Map<number, { row: R; el: ReactElement }>;

/** `rowOf` says what each entry's row is; `make` builds it. The cache that comes back holds only
 * the rows in `entries`, so one that left the log is let go. */
export function cachedRows<E extends { at: number }, R extends Row>(
  cache: RowCache<R>,
  entries: readonly E[],
  rowOf: (entry: E, i: number) => R,
  make: (entry: E, row: R) => ReactElement,
): { rows: ReactElement[]; cache: RowCache<R> } {
  const next: RowCache<R> = new Map();
  const rows = entries.map((entry, i) => {
    const row = rowOf(entry, i);
    const had = cache.get(entry.at);
    const el = had && had.row.kind === row.kind && sameProps(had.row.props, row.props) ? had.el : make(entry, row);
    next.set(entry.at, { row, el });
    return el;
  });
  return { rows, cache: next };
}

/** the same props, by identity; a list is the same when it lists the same things, since a row
 * built from one call is handed its call in a fresh list every time */
function sameProps(a: object, b: object): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!(k in b)) return false;
    const va = (a as Record<string, unknown>)[k];
    const vb = (b as Record<string, unknown>)[k];
    if (Object.is(va, vb)) continue;
    if (!Array.isArray(va) || !Array.isArray(vb) || va.length !== vb.length) return false;
    if (!va.every((v, i) => Object.is(v, vb[i]))) return false;
  }
  return true;
}
