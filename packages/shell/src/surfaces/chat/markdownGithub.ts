import type { TokenizerAndRendererExtension, Tokens } from "marked";
import { escapeHtml } from "./markdownHtml.ts";

// `owner/repo#123` is how an agent names an issue or a pull request on GitHub, and the shape is
// its own: a two-segment slug, a hash, digits. The slug must open a word, not sit at the end of a
// path or an address (`github.com/owner/repo#123` keeps the hash as its fragment), and the digits
// must close one. A bare `#123` is not taken: with no slug it names an issue of this project, which
// the prose cannot say without the project's origin, and it is also what a heading or a count
// looks like. An owner is letters, digits and hyphens; a repository adds dots and underscores.
const OWNER = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?";
const REPO = "[\\w.-]*[\\w-]";
const REF = `(${OWNER}\\/${REPO})#(\\d+)`;
const START = new RegExp(`(^|[^\\w./@-])${REF}(?![\\w-])`);
const TOKEN = new RegExp(`^${REF}(?![\\w-])`);
const WHOLE = new RegExp(`^${REF}$`);
const RUN = new RegExp(START.source, "g");
const ADDRESS = /^https?:\/\/\S+$/;

/** where the bare references in a line of prose start and end, for the person's own words,
 * which are not markdown: the same shape the agent's prose links by */
export function githubRefRanges(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const m of text.matchAll(RUN)) {
    const start = m.index + (m[1] ?? "").length;
    out.push({ start, end: m.index + m[0].length });
  }
  return out;
}

/** the address of the issue or pull request `owner/repo#123` names; GitHub serves a pull request
 * at the issue's address too, so one address covers both */
export function githubIssueUrl(ref: string): string | null {
  const m = WHOLE.exec(ref);
  return m ? `https://github.com/${m[1]}/issues/${m[2]}` : null;
}

/** where a code span goes when it is a place whole: an address, or an issue by its reference.
 * The backticks say "this exact one", which is a reason to open it, not to leave it dead; an
 * address in a fenced block is a link already, and a span is the same code. */
export function codeLink(code: string): string | null {
  return ADDRESS.test(code) ? code : githubIssueUrl(code);
}

/** marked's own code span, wrapped in the link it is when `codeLink` says it is one; the code
 * keeps its face inside the link */
export function linkedCodespan({ text }: Tokens.Codespan): string {
  const code = `<code>${escapeHtml(text)}</code>`;
  const href = codeLink(text);
  return href ? `<a href="${attr(href)}">${code}</a>` : code;
}

const attr = (s: string) => escapeHtml(s).replace(/"/g, "&quot;");

/** `owner/repo#123` bare in the agent's prose, drawn as the link to what it names */
export const githubRef: TokenizerAndRendererExtension = {
  name: "githubRef",
  level: "inline",
  start: (src) => {
    const m = START.exec(src);
    return m ? m.index + m[1]!.length : undefined;
  },
  tokenizer(src) {
    const m = TOKEN.exec(src);
    if (!m) return undefined;
    return { type: "githubRef", raw: m[0], text: m[0], href: githubIssueUrl(m[0]) };
  },
  renderer: (token) => `<a href="${attr(token.href as string)}">${escapeHtml(token.text as string)}</a>`,
};
