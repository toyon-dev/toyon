/** the href a link still being written points at, so the sanitize hook can tell it from a link
 * the agent finished; a fragment, since the sanitizer drops any scheme it does not know */
export const PENDING_LINK = "#toyon-link-pending";

// the unfinished link at the end of a line: `[label` with no closing bracket yet, or `[label](`
// with the url still arriving. `[label]` alone is left as it is, since that is also what a
// checkbox or a plain bracketed word looks like.
const TAIL = /!?\[([^[\]\n]*)(?:\]\(([^()\s]*))?$/;

/** A link the agent is mid-way through writing, rendered as it streams, is its raw text: brackets,
 * label, and a url that can run a line or more. When the closing paren lands it collapses to the
 * label alone and everything under it jumps up. Closing the tail early, on a placeholder href,
 * puts the label in the place the link will take, so the finish moves nothing. Text inside an
 * open fence or an open code span is left alone: a bracket there is code. */
export function closePendingLink(text: string): string {
  const cut = text.lastIndexOf("\n") + 1;
  const line = text.slice(cut);
  const m = TAIL.exec(line);
  if (!m) return text;
  if (inFence(text.slice(0, cut)) || inCodeSpan(line.slice(0, m.index))) return text;
  return `${text.slice(0, cut)}${line.slice(0, m.index)}[${m[1]}](${PENDING_LINK})`;
}

function inFence(before: string): boolean {
  let open = false;
  for (const line of before.split("\n")) if (/^\s*(```|~~~)/.test(line)) open = !open;
  return open;
}

function inCodeSpan(before: string): boolean {
  let n = 0;
  for (const ch of before) if (ch === "`") n++;
  return n % 2 === 1;
}
