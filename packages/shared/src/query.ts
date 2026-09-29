// The grammar of a search box: words, and a quoted run as one phrase. The daemon's chat search and
// the picker filtering names beside its hits read a query the same way, so a quote narrows both.

// straight quotes, and the curly pair macOS types in a field when smart quotes are on
const TERM = /["“”]([^"“”]*)["“”]?|(\S+)/g; // prose-ignore: regex character class

/** What a query is matched by: each bare word, and each quoted run as one term with its spaces kept,
 * lower-cased and listed once. A quote left open runs to the end, so the list narrows the moment
 * the quote is typed and closing it changes nothing. Empty quotes say nothing and are dropped. */
export function queryTerms(query: string): string[] {
  const out = new Set<string>();
  for (const m of query.matchAll(TERM)) {
    const term = (m[1] ?? m[2] ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    if (term) out.add(term);
  }
  return [...out];
}
