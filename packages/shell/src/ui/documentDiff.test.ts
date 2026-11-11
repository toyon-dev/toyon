import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { diffDocument } from "./documentDiff.ts";

// The diff reads and builds real elements. The page is lent for this suite alone: the other
// suites of the run share these globals, and none of them expects a browser.
const page = new JSDOM("").window;
const LENT = ["document", "Node", "NodeFilter"] as const;
const globals = globalThis as Record<string, unknown>;
beforeAll(() => {
  for (const name of LENT) globals[name] = page[name];
});
afterAll(() => {
  for (const name of LENT) delete globals[name];
});

function dom(html: string): HTMLElement {
  const el = page.document.createElement("div");
  el.innerHTML = html;
  return el;
}

const inline = (before: string, after: string) => dom(diffDocument(before, after, false));
const split = (before: string, after: string) => dom(diffDocument(before, after, true));
const texts = (root: Element, selector: string) => Array.from(root.querySelectorAll(selector), (el) => el.textContent);
/** a page's words with the spaces out, which is what survives a mark being set in or taken out */
const squeezed = (root: Element) => (root.textContent ?? "").replace(/\s+/g, "");
function without(root: HTMLElement, selector: string): HTMLElement {
  const copy = root.cloneNode(true) as HTMLElement;
  for (const el of copy.querySelectorAll(selector)) el.remove();
  return copy;
}

const table = (rows: string[][]) =>
  `<div class="md-table"><table><thead><tr>${rows[0]!.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows
    .slice(1)
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;

describe("a rendered document against the one it was", () => {
  test("a page that did not change is the page", () => {
    const html = "<h1>Agents</h1>\n<p>Three come built in.</p>\n";
    expect(inline(html, html).querySelector(".document-came, .document-gone")).toBeNull();
    expect(inline(html, html).innerHTML).toBe("<h1>Agents</h1><p>Three come built in.</p>");
  });

  test("a word that changed is marked where it stands, what went before what came", () => {
    const out = inline("<p>Three come built in.</p>", "<p>Three agents come built in.</p><p>Each signs in.</p>");
    expect(out.children[0]!.innerHTML).toBe('Three <ins class="document-came">agents</ins> come built in.');
    const swapped = inline("<p>It takes a server at start.</p>", "<p>It takes a socket at start.</p>");
    expect(swapped.innerHTML).toBe(
      '<p>It takes a <del class="document-gone">server</del> <ins class="document-came">socket</ins> at start.</p>',
    );
  });

  test("punctuation is a mark of its own, and keeps the spacing it had", () => {
    const out = inline(
      "<p>It does not arrive on its own: Toyon starts it. Give it those.</p>",
      "<p>It does not arrive on its own. Give it those.</p>",
    );
    expect(out.innerHTML).toBe(
      '<p>It does not arrive on its own<del class="document-gone">: Toyon starts it</del>. Give it those.</p>',
    );
    const comma = inline("<p>A mod, a plugin, runs here.</p>", "<p>A mod is a plugin, and runs here.</p>");
    expect(comma.innerHTML).toBe(
      '<p>A mod<del class="document-gone">,</del> <ins class="document-came">is</ins> a plugin, <ins class="document-came">and</ins> runs here.</p>',
    );
    const dropped = inline("<p>No effort levels, and no steering.</p>", "<p>No effort levels, no steering.</p>");
    expect(dropped.innerHTML).toBe('<p>No effort levels, <del class="document-gone">and</del> no steering.</p>');
  });

  test("a block that came or went whole wears the mark itself", () => {
    const out = inline("<h2>Mods</h2><p>Gone now.</p><p>Stays.</p>", "<h2>Mods</h2><p>Stays.</p><pre>new</pre>");
    expect(texts(out, "p.document-gone")).toEqual(["Gone now."]);
    expect(texts(out, "pre.document-came")).toEqual(["new"]);
    expect(out.querySelector("ins, del")).toBeNull();
    expect(texts(out, ":scope > *")).toEqual(["Mods", "Gone now.", "Stays.", "new"]);
  });

  test("a paragraph replaced by another is one gone and one come, not a weave of words", () => {
    const out = inline(
      "<p>The adapter is fetched from npm like the others and loads your settings.</p>",
      "<p>Codex reads its own config file, and its sandbox takes no deny list.</p>",
    );
    expect(out.querySelector("ins, del")).toBeNull();
    expect(out.children[0]!.className).toBe("document-gone");
    expect(out.children[1]!.className).toBe("document-came");
  });

  test("a heading that changed level is another heading", () => {
    const out = inline("<h2>Flags</h2>", "<h3>Flags</h3>");
    expect(out.innerHTML).toBe('<h2 class="document-gone">Flags</h2><h3 class="document-came">Flags</h3>');
  });

  test("a chance match between two rewritten stretches is part of the rewrite", () => {
    const out = inline(
      "<p>What the terminal gets does not arrive.</p>",
      "<p>Toyon starts the agent from the Dock, so what the terminal gets does not arrive.</p>",
    );
    expect(texts(out, "del")).toEqual(["What"]);
    expect(texts(out, "ins")).toEqual(["Toyon starts the agent from the Dock, so what"]);
    // one word kept between a sentence that came and a word that came is still kept
    const kept = inline(
      "<p>One session per copy. Three come built in.</p>",
      "<p>One session per copy. A copy is a branch and a worktree. Three agents come built in.</p>",
    );
    expect(texts(kept, "del")).toEqual([]);
    expect(texts(kept, "ins")).toEqual(["A copy is a branch and a worktree.", "agents"]);
  });

  test("a table is compared by its rows and then its cells", () => {
    const before = table([
      ["", "Claude", "Codex"],
      ["Subagents", "yes", "yes"],
      ["Effort", "yes", "no"],
      ["Tools", "yes", "only if it says so"],
    ]);
    const after = table([
      ["", "Claude", "Codex"],
      ["Subagents", "yes", "yes"],
      ["Tools", "yes", "only if it announces it"],
      ["Steering", "yes", "yes"],
    ]);
    const out = inline(before, after);
    expect(texts(out, "tbody tr").map((t) => t?.slice(0, 5))).toEqual(["Subag", "Effor", "Tools", "Steer"]);
    expect(texts(out, "tr.document-gone td")).toEqual(["Effort", "yes", "no"]);
    expect(texts(out, "tr.document-came td")).toEqual(["Steering", "yes", "yes"]);
    expect(texts(out, "del")).toEqual(["says so"]);
    expect(texts(out, "ins")).toEqual(["announces it"]);
    // the table itself stayed
    expect(out.children[0]!.className).toBe("md-table");
  });

  test("a table that gained a column is another table", () => {
    const out = inline(table([["a", "b"]]), table([["a", "b", "c"]]));
    expect(out.children[0]!.className).toBe("md-table document-gone");
    expect(out.children[1]!.className).toBe("md-table document-came");
  });

  test("a list is compared by its items", () => {
    const out = inline(
      "<ul><li>this worktree,</li><li>a new worktree,</li><li>an open one.</li></ul>",
      "<ul><li>this worktree,</li><li>an open worktree.</li><li>or none.</li></ul>",
    );
    expect(out.children).toHaveLength(1);
    expect(texts(out, "li.document-gone")).toEqual(["a new worktree,"]);
    expect(texts(out, "li.document-came")).toEqual(["or none."]);
    expect(out.querySelectorAll("li")[2]!.innerHTML).toBe(
      'an open <del class="document-gone">one</del> <ins class="document-came">worktree</ins>.',
    );
  });

  test("a link that went elsewhere, a word that turned to code and a ticked box are changes", () => {
    const link = inline(
      '<p>See <a href="trust.md">the trust page</a>.</p>',
      '<p>See <a href="policy.md">the trust page</a>.</p>',
    );
    expect(link.querySelector("del a")?.getAttribute("href")).toBe("trust.md");
    expect(link.querySelector("a ins")?.textContent).toBe("the trust page");
    const code = inline("<p>Run handoff first.</p>", "<p>Run <code>handoff</code> first.</p>");
    expect(code.innerHTML).toBe(
      '<p>Run <del class="document-gone">handoff</del> <code><ins class="document-came">handoff</ins></code> first.</p>',
    );
    const box = inline(
      '<ul><li><input disabled="" type="checkbox"> ship it</li></ul>',
      '<ul><li><input checked="" disabled="" type="checkbox"> ship it</li></ul>',
    );
    expect(box.querySelector("del input")?.hasAttribute("checked")).toBe(false);
    expect(box.querySelector("ins input")?.hasAttribute("checked")).toBe(true);
  });

  test("what went from inside a mark keeps the mark, and is not set into another's", () => {
    const out = inline(
      "<p>Give it <code>env</code> and <code>meta</code> there.</p>",
      "<p>Give it <code>meta</code> there.</p>",
    );
    expect(out.innerHTML).toBe(
      '<p>Give it <del class="document-gone"><code>env</code> and</del> <code>meta</code> there.</p>',
    );
  });

  test("what went is set into a line as words, never as a block or a mark inside its own kind", () => {
    const whole = (out: HTMLElement) => expect(dom(out.innerHTML).innerHTML).toBe(out.innerHTML);
    const quote = inline(
      "<blockquote><p>Keep a copy that matters on ask.</p></blockquote>",
      "<blockquote><p>Leave a copy that matters on ask.</p></blockquote>",
    );
    expect(quote.innerHTML).toBe(
      '<blockquote><p><del class="document-gone">Keep</del> <ins class="document-came">Leave</ins> a copy that matters on ask.</p></blockquote>',
    );
    const loose = inline("<ul><li><p>First thing here.</p></li></ul>", "<ul><li><p>Second thing here.</p></li></ul>");
    expect(loose.querySelector("li")!.innerHTML).toBe(
      '<p><del class="document-gone">First</del> <ins class="document-came">Second</ins> thing here.</p>',
    );
    const link = inline(
      '<p>See <a href="t.md">the trust page</a> first.</p>',
      '<p>See <a href="t.md">the policy page</a> first.</p>',
    );
    expect(link.querySelector("a")!.innerHTML).toBe(
      'the <del class="document-gone">trust</del> <ins class="document-came">policy</ins> page',
    );
    const chip = inline("<p>Run <code>git push origin</code> now.</p>", "<p>Run <code>git pull origin</code> now.</p>");
    expect(chip.querySelector("code")!.innerHTML).toBe(
      'git <del class="document-gone">push</del> <ins class="document-came">pull</ins> origin',
    );
    const nested = inline(
      "<ul><li>tools<ul><li>worktrees lists them</li><li>handoff splits work</li><li>own takes a command</li></ul></li></ul>",
      "<ul><li>tools<ul><li>worktrees lists them</li></ul></li></ul>",
    );
    expect(nested.querySelector("del li, del ul")).toBeNull();
    expect(texts(nested, "del")).toEqual(["handoff splits work own takes a command"]);
    for (const out of [quote, loose, link, chip, nested]) whole(out);
  });

  test("the page without what went is the new one, and without what came the old one", () => {
    const before =
      "<h1>Agents</h1><p>Toyon drives agents over ACP. Three come built in: Claude Code, Codex and OpenCode.</p>" +
      "<p>Its sandbox takes no deny list, and nothing but the instruction stops it pushing.</p>" +
      "<p><code>env</code> is added to the environment. <code>meta</code> rides every session.</p>" +
      table([
        ["", "Claude"],
        ["Tools", "yes"],
      ]);
    const after =
      "<h1>Agents</h1><p>Toyon drives agents over ACP. A copy is a branch. Three agents come built in: Claude Code, Codex and OpenCode.</p>" +
      "<p>Its sandbox takes no deny list, and only the instruction stops it pushing.</p><h3>Flags</h3>" +
      "<ul><li><code>env</code> is added to the environment.</li><li><code>meta</code> rides every session.</li></ul>" +
      table([
        ["", "Claude"],
        ["Tools", "no"],
      ]);
    const out = inline(before, after);
    expect(dom(out.innerHTML).innerHTML).toBe(out.innerHTML);
    expect(squeezed(without(out, ".document-gone"))).toBe(squeezed(dom(after)));
    expect(squeezed(without(out, ".document-came"))).toBe(squeezed(dom(before)));
    const sides = split(before, after);
    expect(squeezed(without(sides, ":scope > :nth-child(odd)"))).toBe(squeezed(dom(after)));
    expect(squeezed(without(sides, ":scope > :nth-child(even)"))).toBe(squeezed(dom(before)));
  });

  test("split is a row per block: as it was on the left, as it is on the right", () => {
    const out = split(
      "<h1>Agents</h1><p>Three come built in.</p><p>One long paragraph about tools.</p><h2>Codex</h2>",
      "<h1>Agents</h1><p>Three agents come built in.</p><p>Tools, first.</p><p>Tools, second.</p><h2>Codex</h2>",
    );
    const cells = Array.from(out.children);
    expect(cells).toHaveLength(8);
    // an edited block is marked on each side with its own half
    expect(cells[2]!.innerHTML).toBe("<p>Three come built in.</p>");
    expect(cells[3]!.innerHTML).toBe('<p>Three <ins class="document-came">agents</ins> come built in.</p>');
    // what went and what came in its place share a row
    expect(texts(cells[4]!, "p.document-gone")).toEqual(["One long paragraph about tools."]);
    expect(texts(cells[5]!, "p.document-came")).toEqual(["Tools, first.", "Tools, second."]);
    expect(cells[6]!.textContent).toBe("Codex");
    expect(cells[7]!.textContent).toBe("Codex");
  });

  test("split leaves the other side of a block that only came or only went empty", () => {
    const out = split("<p>Stays.</p>", "<p>Stays.</p><p>New.</p>");
    expect(Array.from(out.children, (c) => c.innerHTML)).toEqual([
      "<p>Stays.</p>",
      "<p>Stays.</p>",
      "",
      '<p class="document-came">New.</p>',
    ]);
  });

  test("text standing loose between blocks is kept", () => {
    expect(texts(inline("<p>a</p>", "<p>a</p>\nloose words\n"), "p.document-came")).toEqual(["\nloose words\n"]);
  });
});
