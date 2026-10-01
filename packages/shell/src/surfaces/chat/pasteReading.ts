import { renderedAs } from "@toyon/shared";

/** how a paste opens at full size: rendered, as its text with the rendering one press away, or as
 * its text alone */
export type PasteReading = "rendered" | "source" | "plain";

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^#{1,6} \S/;
const LIST = /^\s*(?:[-*+]|\d+[.)]) \S/;
const QUOTE = /^> ?\S/;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
// an address or a path in the parentheses, so `handlers[name](arg)` is not a link
const LINK = /\[[^\]\n]+\]\((?:https?:|\.{0,2}\/|#)[^)\s]*\)/;
const BOLD = /\*\*[^\s*][^*\n]*\*\*/;

/** How many kinds of markdown structure a text shows. Kinds and not marks, because each mark alone
 * is something else's too: `#` opens a comment in a script, `-` a list in YAML, `**` a power in
 * Python. What sits inside a fenced block is code, so it is never counted. */
export function markdownSigns(text: string): number {
  const lines = text.split("\n");
  const kinds = new Set<string>();
  let fence: string | null = null;
  let items = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const mark = FENCE.exec(line)?.[1];
    if (fence) {
      if (mark?.startsWith(fence)) {
        fence = null;
        kinds.add("fence");
      }
      continue;
    }
    if (mark) {
      fence = mark;
      continue;
    }
    // a heading stands apart from what it heads; a comment sits on the line it explains
    if (HEADING.test(line) && !lines[i + 1]?.trim()) kinds.add("heading");
    if (LIST.test(line) && ++items === 2) kinds.add("list");
    if (QUOTE.test(line)) kinds.add("quote");
    if (TABLE_RULE.test(line)) kinds.add("table");
    if (LINK.test(line)) kinds.add("link");
    if (BOLD.test(line)) kinds.add("bold");
  }
  return kinds.size;
}

/** A paste that came out of a file is what the file is. One off the clipboard is rendered only
 * when two kinds of structure agree that it is markdown: rendering a log or a script folds its
 * lines and eats its marks, which is worse than a document left as text. One kind is enough to
 * offer it. */
export function pasteReading(text: string, path: string | undefined): PasteReading {
  if (path) return renderedAs(path) === "markdown" ? "rendered" : "plain";
  const signs = markdownSigns(text);
  return signs >= 2 ? "rendered" : signs === 1 ? "source" : "plain";
}
