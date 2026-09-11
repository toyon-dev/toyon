// The one span that turns a text into another, cut at line starts. What the two share at the top
// and the bottom stays where it is, so the caret and the undo history outside the change are left
// alone when the file on disk changes under an editor with nothing unsaved.

/** each line with its own ending, so no cut ever falls between a \r and its \n */
const linesOf = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

export function minimalEdit(from: string, to: string): { start: number; end: number; text: string } | null {
  if (from === to) return null;
  const a = linesOf(from);
  const b = linesOf(to);
  let head = 0;
  let start = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) {
    start += a[head]!.length;
    head++;
  }
  let tail = 0;
  let cut = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    cut += a[a.length - 1 - tail]!.length;
    tail++;
  }
  return { start, end: from.length - cut, text: to.slice(start, to.length - cut) };
}
