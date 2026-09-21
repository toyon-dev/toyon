/** Codex reasoning summaries are short status lines wrapped wholly in Markdown emphasis. Inside a
 * panel already labelled Thought, those read as document headings rather than quiet progress. Drop
 * only a complete line's wrapper; emphasis within ordinary prose keeps its meaning. */
export function normalizeThoughtMarkdown(text: string): string {
  return text.replace(/^([\t ]*)\*\*(\S(?:[^\n]*\S)?)\*\*([\t ]*)$/gm, "$1$2$3");
}

/** A thought that is one short line, or "". Codex's reasoning summaries are a headline per step
 * ("Inspecting module documentation"), sent whole, and a card folded around one line is a lid on
 * nothing: the line is the row. Only a finished thought is read this way, since one still arriving
 * may be a paragraph's first words. Backticks go, as the line prints as text and not as markdown. */
export function thoughtLine(text: string): string {
  const line = normalizeThoughtMarkdown(text).trim().replace(/`/g, "");
  return line && !line.includes("\n") && line.length <= 120 ? line : "";
}
