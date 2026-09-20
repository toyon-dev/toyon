import type { Renderer, Tokens } from "marked";

// GFM makes a table only from a header row, so an agent laying out plain rows writes an empty one,
// and marked keeps it: a shaded band with nothing in it above the first row. A head with no words
// is left out; returning false hands a table with a real head back to the default.
export function table(this: Renderer, token: Tokens.Table): string | false {
  if (token.header.some((cell) => cell.text.trim())) return false;
  let body = "";
  for (const row of token.rows) {
    let cells = "";
    for (const cell of row) cells += this.tablecell(cell);
    body += this.tablerow({ text: cells });
  }
  return `<table>\n<tbody>${body}</tbody></table>\n`;
}
