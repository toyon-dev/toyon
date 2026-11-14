import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// editor.css takes the word tint off a line that is new or gone entire, and the only handle Monaco
// gives is the inline style its whole-line decorations print. A Monaco that prints it another way
// leaves the rule matching nothing and the tint back with no error, so the string is held here.
const monaco = join(import.meta.dir, "../../../node_modules/monaco-editor/esm/vs/editor/browser");

test("monaco prints a whole-line decoration at the width editor.css selects on", () => {
  const decorations = readFileSync(join(monaco, "viewParts/decorations/decorations.js"), "utf8");
  expect(decorations).toContain('" style="left:0;width:100%;"></div>');
  const css = readFileSync(join(import.meta.dir, "editor.css"), "utf8");
  expect(css).toContain('.cdr:is(.char-insert, .char-delete)[style*="width:100%"]');
});

test("monaco marks a wholly new line with the word class across the whole line", () => {
  const registrations = readFileSync(join(monaco, "widget/diffEditor/registrations.contribution.js"), "utf8");
  expect(registrations).toMatch(/diffWholeLineAddDecoration[^}]*className: 'char-insert',[^}]*isWholeLine: true/);
  expect(registrations).toMatch(/diffWholeLineDeleteDecoration[^}]*className: 'char-delete',[^}]*isWholeLine: true/);
});
