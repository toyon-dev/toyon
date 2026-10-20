import { Renderer as DefaultRenderer, type Renderer, type Tokens } from "marked";

// Every table sits in a scroller of its own (.md-table): a cell keeps its words whole, so a table
// of paths can be wider than the column, and without the box it is the whole transcript that
// scrolls sideways.
export function table(this: Renderer, token: Tokens.Table): string {
  return `<div class="md-table">${rows.call(this, token)}</div>\n`;
}

// GFM makes a table only from a header row, so an agent laying out plain rows writes an empty one,
// and marked keeps it: a shaded band with nothing in it above the first row. A head with no words
// is left out.
function rows(this: Renderer, token: Tokens.Table): string {
  if (token.header.some((cell) => cell.text.trim())) return DefaultRenderer.prototype.table.call(this, token);
  let body = "";
  for (const row of token.rows) {
    let cells = "";
    for (const cell of row) cells += this.tablecell(cell);
    body += this.tablerow({ text: cells });
  }
  return `<table>\n<tbody>${body}</tbody></table>\n`;
}
