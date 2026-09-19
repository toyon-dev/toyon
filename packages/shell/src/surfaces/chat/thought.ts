/** Codex reasoning summaries are short status lines wrapped wholly in Markdown emphasis. Inside a
 * panel already labelled Thought, those read as document headings rather than quiet progress. Drop
 * only a complete line's wrapper; emphasis within ordinary prose keeps its meaning. */
export function normalizeThoughtMarkdown(text: string): string {
  return text.replace(/^([\t ]*)\*\*(\S(?:[^\n]*\S)?)\*\*([\t ]*)$/gm, "$1$2$3");
}
