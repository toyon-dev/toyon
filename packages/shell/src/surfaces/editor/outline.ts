/** How far each heading sits under the ones above it: the count of open headings of a lower level,
 * not the level itself. An h1 is the document's title, not a section: it stands at the margin and
 * opens no level, so the sections under it stand at the margin too. An h3 under an h2 is one step
 * in; an h3 with no h2 above it stands at the margin, and an h4 straight under an h2 is one step
 * in, not two. */
export function outlineDepths(levels: number[]): number[] {
  const open: number[] = [];
  return levels.map((level) => {
    while (open.length && open[open.length - 1]! >= level) open.pop();
    if (level === 1) return 0;
    const depth = open.length;
    open.push(level);
    return depth;
  });
}
