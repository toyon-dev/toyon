/** How far each heading sits under the ones above it: the count of open headings of a lower level,
 * not the level itself. An h2 under an h1 is one step in; an h2 with no h1 above it stands at the
 * margin, and an h3 straight under an h1 is one step in, not two. */
export function outlineDepths(levels: number[]): number[] {
  const open: number[] = [];
  return levels.map((level) => {
    while (open.length && open[open.length - 1]! >= level) open.pop();
    const depth = open.length;
    open.push(level);
    return depth;
  });
}
