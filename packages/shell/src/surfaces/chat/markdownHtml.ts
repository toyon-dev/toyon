import type { Tokens } from "marked";

export const escapeHtml = (s: string) =>
  s.replace(/[&<>]/g, (ch) => (ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : "&gt;"));

/** raw HTML in prose, drawn as the text it is. An agent writes a placeholder like <title> or
 * <path> in a reply as naturally as a word, and the browser's parser reads it as the tag: a
 * title, textarea, style or script tag takes everything after it as its own text, the sanitizer
 * keeps that, and the page never draws it, so the reply ends there with no sign it was cut. */
export function htmlAsText({ text }: Tokens.HTML | Tokens.Tag): string {
  return escapeHtml(text);
}
