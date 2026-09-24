/** Codex reasoning summaries are short status lines wrapped wholly in Markdown emphasis. Inside a
 * panel already labelled Thought, those read as document headings rather than quiet progress. Drop
 * only a complete line's wrapper; emphasis within ordinary prose keeps its meaning. */
export function normalizeThoughtMarkdown(text: string): string {
  return text.replace(/^([\t ]*)\*\*(\S(?:[^\n]*\S)?)\*\*([\t ]*)$/gm, "$1$2$3");
}

/** the longest line that is read as a line and not as prose */
const LINE = 120;

/** a whole line wrapped in bold: the shape of a Codex reasoning headline, and nothing else that
 * arrives as a thought */
const HEADLINE = /^\*\*(\S(?:[^\n]*\S)?)\*\*$/;

/** The headlines of a thought written as a column of them, or []. Codex sends its reasoning a
 * summary part per step, each one bold headline, and a run of steps with no call between them lands
 * in one thought with a blank line between the parts. A thought of that shape is read by its newest
 * headline, the way Codex's own status line reads it, with the ones before folded under. The shape
 * is exact, every part a headline, so a thought with a paragraph among them is read as prose. */
export function thoughtSteps(text: string): string[] {
  const steps: string[] = [];
  for (const part of text.split(/\n[\t ]*\n/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const line = HEADLINE.exec(trimmed)?.[1]?.replace(/`/g, "") ?? "";
    if (!line || line.length > LINE) return [];
    steps.push(line);
  }
  return steps;
}

/** A thought that is read as one line, or "". Codex's reasoning summaries are a headline per step
 * ("Inspecting module documentation"), sent whole, and a card folded around one line is a lid on
 * nothing: the line is the row. A column of headlines is read by its newest (thoughtSteps). Only
 * a finished thought is read this way, since one still arriving may be a paragraph's first words.
 * Backticks go, as the line prints as text and not as markdown. */
export function thoughtLine(text: string): string {
  const steps = thoughtSteps(text);
  if (steps.length) return steps.at(-1)!;
  const line = normalizeThoughtMarkdown(text).trim().replace(/`/g, "");
  return line && !line.includes("\n") && line.length <= LINE ? line : "";
}
