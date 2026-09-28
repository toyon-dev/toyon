/**
 * Finding a phrase in a document drawn from many text nodes.
 *
 * The nodes' text is read as one string, so a match may cross a node boundary (the "bra" in bold
 * and the "nch" after it); `spanOf` maps a match back to the nodes it starts and ends in, which is
 * what a Range takes. Nothing here touches the DOM, so it is tested as text.
 */

/** where one node's text sits in the joined string */
export type Segment = { start: number; len: number };

/** a place in the joined string, as the node it falls in and the offset inside that node */
export type Place = { i: number; at: number };

export type Match = { start: number; end: number };

export function segmentsOf(lengths: readonly number[]): Segment[] {
  let start = 0;
  return lengths.map((len) => {
    const seg = { start, len };
    start += len;
    return seg;
  });
}

/** The browser's find ignores case, and so does this. The query is matched as a pattern rather than
 * lowered first: lowering can change a string's length ("İ" lowers to two code units), and an
 * offset read off the lowered copy would then point into the wrong node. */
export function matchOffsets(text: string, query: string): Match[] {
  if (!query) return [];
  const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  const found: Match[] = [];
  for (const m of text.matchAll(re)) found.push({ start: m.index, end: m.index + m[0].length });
  return found;
}

/** the node an offset falls in. An end offset is exclusive, so on a boundary it stays in the node
 * it closes rather than opening the next one, and a Range ends where the text does. */
function placeOf(segments: readonly Segment[], offset: number, end: boolean): Place {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const s = segments[mid]!;
    const after = end ? offset > s.start + s.len : offset >= s.start + s.len;
    if (after) lo = mid + 1;
    else hi = mid;
  }
  const s = segments[lo]!;
  return { i: lo, at: offset - s.start };
}

export function spanOf(segments: readonly Segment[], match: Match): { from: Place; to: Place } {
  return { from: placeOf(segments, match.start, false), to: placeOf(segments, match.end, true) };
}

/** the match a refined query lands on: the first one at or past where the eye already was, so
 * typing one more letter narrows the list without sending the reader back to the top */
export function nearestIndex(matches: readonly Match[], offset: number): number {
  if (matches.length === 0) return -1;
  const i = matches.findIndex((m) => m.start >= offset);
  return i === -1 ? 0 : i;
}

/** the next or previous match, wrapping at either end */
export function stepped(at: number, count: number, dir: 1 | -1): number {
  if (count === 0) return -1;
  return (at + dir + count) % count;
}

export function isFind(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }) {
  return e.key === "f" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
}
