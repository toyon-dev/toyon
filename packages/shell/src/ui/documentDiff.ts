/**
 * A rendered document against the one it was, as the page itself: what came is tinted, what went
 * is set back in where it stood. The two renders are compared, not the two sources, so a paragraph
 * wrapped at another column is the same paragraph, and a table is compared cell by cell.
 *
 * Three depths. Blocks first: one that is the same on both sides is drawn once, one that came or
 * went whole is drawn whole in its tint. A block that left and one that came in its place, of one
 * kind and mostly the same words, are read as one block edited, and compared inside: a table by
 * its rows and then its cells, a list by its items, and anything else by its words.
 */

type Op = { k: "same"; o: number; n: number } | { k: "gone"; o: number } | { k: "came"; n: number };
type Row = Op | { k: "edit"; o: number; n: number };

/** the classes a mark wears (document.css): on a block, a row or an item that came or went whole,
 * and on the `ins` or `del` around words inside one that stayed. Markdown's own strikethrough is
 * a bare `del`, and is not a mark. */
const CAME = "document-came";
const GONE = "document-gone";

/** past this many cells the table that aligns two lists is not built: the lists are read as one
 * stretch gone and one come, which is what a rewrite that large is */
const LCS_CELLS = 4_000_000;

/** the edit script between two lists of keys */
function align(a: readonly string[], b: readonly string[]): Op[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const n = a.length - head - tail;
  const m = b.length - head - tail;
  const ops: Op[] = [];
  for (let i = 0; i < head; i++) ops.push({ k: "same", o: i, n: i });
  if (n * m > LCS_CELLS) {
    for (let i = 0; i < n; i++) ops.push({ k: "gone", o: head + i });
    for (let j = 0; j < m; j++) ops.push({ k: "came", n: head + j });
  } else if (n && m) {
    const t = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        t[i]![j] = a[head + i] === b[head + j] ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[head + i] === b[head + j]) ops.push({ k: "same", o: head + i++, n: head + j++ });
      else if (t[i + 1]![j]! >= t[i]![j + 1]!) ops.push({ k: "gone", o: head + i++ });
      else ops.push({ k: "came", n: head + j++ });
    }
    for (; i < n; i++) ops.push({ k: "gone", o: head + i });
    for (; j < m; j++) ops.push({ k: "came", n: head + j });
  } else {
    for (let i = 0; i < n; i++) ops.push({ k: "gone", o: head + i });
    for (let j = 0; j < m; j++) ops.push({ k: "came", n: head + j });
  }
  for (let i = 0; i < tail; i++) ops.push({ k: "same", o: head + n + i, n: head + m + i });
  return ops;
}

type Kind = "table" | "list" | "leaf";

function kindOf(el: Element): Kind {
  if (el.classList.contains("md-table")) return "table";
  if (el.tagName === "UL" || el.tagName === "OL") return "list";
  return "leaf";
}

/** what a block is compared by inside: a table's rows, a list's items */
const partsOf = (el: Element): Element[] =>
  kindOf(el) === "table" ? Array.from(el.querySelectorAll("tr")) : Array.from(el.children);

const cellsOf = (row: Element): Element[] => Array.from(row.children);

/** two blocks can be one block edited only when they are the same thing: a heading that changed
 * level is another heading, and a table that gained a column has no cell to compare with cell */
function shapeOf(el: Element): string {
  const kind = kindOf(el);
  if (kind !== "table") return `${el.tagName} ${kind}`;
  return `table ${el.querySelector("tr")?.children.length ?? 0}`;
}

/** an element's words on one line. Each text is taken apart from the next: two cells of a row
 * have no space between them, and their words are not one word. */
function flat(el: Node): string {
  const parts: string[] = [];
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walk.nextNode(); node; node = walk.nextNode()) parts.push((node as Text).data);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** a block's words and how often each stands in it, read once per block */
const bags = new WeakMap<Element, { count: number; words: Map<string, number> }>();
function bagOf(el: Element) {
  let bag = bags.get(el);
  if (!bag) {
    const words = new Map<string, number>();
    const all = flat(el).split(" ").filter(Boolean);
    for (const w of all) words.set(w, (words.get(w) ?? 0) + 1);
    bag = { count: all.length, words };
    bags.set(el, bag);
  }
  return bag;
}

/** how much of two blocks is the same words, 0 to 1, and 0 for two that are not the same thing.
 * A table's row is the row it was while its first cell names it. */
function alike(o: Element, n: Element): number {
  if (shapeOf(o) !== shapeOf(n)) return 0;
  if (o.tagName === "TR" && o.children[0] && n.children[0] && flat(o.children[0]) === flat(n.children[0])) return 1;
  const [a, b] = [bagOf(o), bagOf(n)];
  if (!a.count || !b.count) return 0;
  let shared = 0;
  for (const [w, k] of a.words) shared += Math.min(k, b.words.get(w) ?? 0);
  return (2 * shared) / (a.count + b.count);
}

/** two blocks at least this alike are one block edited; under it, one went and another came. Half:
 * a paragraph rewritten sentence by sentence keeps well over half its words, and one replaced by
 * another on the same subject keeps a third. */
const EDITED = 0.5;

/** two runs of blocks as rows: the same, gone, come, or edited */
function rowsOf(olds: readonly Element[], news: readonly Element[]): Row[] {
  const key = (el: Element) => `${el.tagName}\n${el.innerHTML}`;
  const ops = align(olds.map(key), news.map(key));
  const rows: Row[] = [];
  for (let x = 0; x < ops.length; ) {
    const op = ops[x]!;
    if (op.k === "same") {
      rows.push(op);
      x++;
      continue;
    }
    // a stretch that differs: what left it and what came into it, paired in order where a pair
    // is alike enough, so the pairs never cross
    const gone: number[] = [];
    const came: number[] = [];
    for (; x < ops.length && ops[x]!.k !== "same"; x++) {
      const at = ops[x]!;
      if (at.k === "gone") gone.push(at.o);
      else if (at.k === "came") came.push(at.n);
    }
    const score = gone.map((o) => came.map((n) => alike(olds[o]!, news[n]!)));
    const t = Array.from({ length: gone.length + 1 }, () => new Float64Array(came.length + 1));
    for (let i = gone.length - 1; i >= 0; i--) {
      for (let j = came.length - 1; j >= 0; j--) {
        const pair = score[i]![j]! >= EDITED ? t[i + 1]![j + 1]! + score[i]![j]! : 0;
        t[i]![j] = Math.max(t[i + 1]![j]!, t[i]![j + 1]!, pair);
      }
    }
    let i = 0;
    let j = 0;
    while (i < gone.length && j < came.length) {
      const s = score[i]![j]!;
      if (s >= EDITED && t[i]![j] === t[i + 1]![j + 1]! + s) rows.push({ k: "edit", o: gone[i++]!, n: came[j++]! });
      else if (t[i + 1]![j]! >= t[i]![j + 1]!) rows.push({ k: "gone", o: gone[i++]! });
      else rows.push({ k: "came", n: came[j++]! });
    }
    for (; i < gone.length; i++) rows.push({ k: "gone", o: gone[i]! });
    for (; j < came.length; j++) rows.push({ k: "came", n: came[j]! });
  }
  return rows;
}

/** a word, a mark of punctuation, or something drawn that holds no text (a picture, a task's
 * box), with where it sits. Its key carries the marks over it, so a word that turned bold or a
 * link that went elsewhere is a word that changed. */
type Token = { key: string } & ({ node: Text; start: number; end: number } | { el: Element });

/** punctuation is a token of its own: "own:" turned "own." is one mark changed, not the word */
const WORD = /[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu;
const DRAWN = new Set(["IMG", "INPUT"]);
/** the marks a run of words can sit under and still be a run of words. What went is carried with
 * these and set in among these; anything else (a paragraph, an item) is a block, and a block set
 * into a line is HTML the page would be reparsed out of. */
const INLINE = new Set([
  "A",
  "ABBR",
  "B",
  "BR",
  "CODE",
  "DEL",
  "EM",
  "I",
  "INS",
  "KBD",
  "MARK",
  "S",
  "SMALL",
  "SPAN",
  "STRONG",
  "SUB",
  "SUP",
  "U",
]);
const inline = (node: Node | null): node is Element => !!node && INLINE.has((node as Element).tagName);

function tokensOf(root: Element): Token[] {
  const out: Token[] = [];
  const marksOver = (node: Node): string => {
    let marks = "";
    for (let p = node.parentNode; p && p !== root; p = p.parentNode) {
      const el = p as Element;
      marks += el.tagName === "A" ? `A ${el.getAttribute("href") ?? ""}>` : `${el.tagName}>`;
    }
    return marks;
  };
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walk.nextNode(); node; node = walk.nextNode()) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      if (DRAWN.has(el.tagName)) out.push({ key: marksOver(el) + el.outerHTML, el });
      continue;
    }
    const text = node as Text;
    const marks = marksOver(text);
    for (const m of text.data.matchAll(WORD)) {
      out.push({ key: marks + m[0], node: text, start: m.index, end: m.index + m[0].length });
    }
  }
  return out;
}

/** whether token `i` stands apart from the one before it; the first of a block does */
function spaced(toks: readonly Token[], i: number): boolean {
  const a = toks[i - 1];
  const b = toks[i];
  if (!a || !b || !("node" in a) || !("node" in b)) return true;
  if (a.node === b.node) return /\s/.test(a.node.data.slice(a.end, b.start));
  // each is the last or the first word of its own text, so anything around it there is space
  return a.end < a.node.data.length || b.start > 0;
}

/** The words of two blocks aligned, with the chance matches taken back out: between two rewritten
 * stretches a "the" that happens to stand in both is part of the rewrite, and kept as common
 * ground it cuts one change into confetti. A stretch held in common stays only while it is at
 * least as many words as the smaller change beside it, so one word kept between two words
 * changed is still kept. */
function alignWords(a: readonly Token[], b: readonly Token[]): Op[] {
  const ops = align(
    a.map((t) => t.key),
    b.map((t) => t.key),
  );
  type Run = { same: boolean; ops: Op[] };
  const runs: Run[] = [];
  for (const op of ops) {
    const same = op.k === "same";
    const last = runs[runs.length - 1];
    if (last && last.same === same) last.ops.push(op);
    else runs.push({ same, ops: [op] });
  }
  const size = (run: Run): number => {
    const gone = run.ops.filter((op) => op.k !== "came").length;
    return Math.max(gone, run.ops.length - (run.same ? 0 : gone));
  };
  for (let i = 1; i < runs.length - 1; ) {
    const [before, run, after] = [runs[i - 1]!, runs[i]!, runs[i + 1]!];
    if (!run.same || size(run) >= Math.min(size(before), size(after))) {
      i++;
      continue;
    }
    const taken: Op[] = run.ops.flatMap((op) =>
      op.k === "same" ? [{ k: "gone", o: op.o } as const, { k: "came", n: op.n } as const] : [],
    );
    runs.splice(i - 1, 3, { same: false, ops: [...before.ops, ...taken, ...after.ops] });
    // the change just grew, and the stretch before it is measured against it again
    i = Math.max(1, i - 2);
  }
  return runs.flatMap((run) => run.ops);
}

/** what is set into a block: before the token it names, or at the block's end when it names
 * none; `back` sets it that many characters earlier, ahead of the space the token stands after */
type Insert = { before: Token | undefined; nodes: (Node | string)[]; back?: number };

/** Wrap the flagged tokens of a block in `tag`, a run of words in one text as one mark with the
 * spaces between them, and set each insert in before the token it names (at the block's end when
 * it names none). */
function paint(
  root: Element,
  toks: readonly Token[],
  flagged: readonly boolean[],
  tag: "ins" | "del",
  cls: string,
  inserts: readonly Insert[] = [],
) {
  const mark = () => {
    const el = document.createElement(tag);
    el.className = cls;
    return el;
  };
  type Edit = { start: number; end: number; nodes?: (Node | string)[] };
  const edits = new Map<Text, Edit[]>();
  const editsOf = (node: Text) => {
    let list = edits.get(node);
    if (!list) {
      list = [];
      edits.set(node, list);
    }
    return list;
  };
  const wraps = new Map<Element, Element>();
  toks.forEach((tok, i) => {
    if (!flagged[i]) return;
    if ("el" in tok) {
      const wrap = mark();
      tok.el.replaceWith(wrap);
      wrap.append(tok.el);
      wraps.set(tok.el, wrap);
      return;
    }
    const list = editsOf(tok.node);
    const prev = toks[i - 1];
    const last = list[list.length - 1];
    if (last && flagged[i - 1] && prev && "node" in prev && prev.node === tok.node) last.end = tok.end;
    else list.push({ start: tok.start, end: tok.end });
  });
  // What went carries the marks it stood under (lifted, below). Set in under one of the same,
  // it sheds its own: a link inside a link is not HTML, and a chip inside a chip is one chip.
  const shed = (nodes: (Node | string)[], under: Node | null) => {
    for (let over = under; inline(over) && over !== root; over = over.parentNode) {
      for (const node of nodes) {
        if (typeof node === "string") continue;
        for (const el of (node as Element).querySelectorAll(over.tagName)) el.replaceWith(...el.childNodes);
      }
    }
    return nodes;
  };
  for (const { before, nodes, back = 0 } of inserts) {
    if (!before) {
      root.append(...nodes);
      continue;
    }
    if ("el" in before) {
      const seat = wraps.get(before.el) ?? before.el;
      seat.before(...shed(nodes, seat.parentNode));
      continue;
    }
    // Before the first word of a mark's own text (a code chip, a link), what went is set outside
    // the mark: inside, it would be drawn as code that was never code.
    const first = !back && toks.find((t) => "node" in t && t.node === before.node) === before;
    let seat: Node = before.node;
    while (first && !seat.previousSibling && seat.parentNode !== root && inline(seat.parentNode)) {
      seat = seat.parentNode;
    }
    shed(nodes, seat.parentNode);
    if (seat !== before.node) (seat as Element).before(...nodes);
    else editsOf(before.node).push({ start: before.start - back, end: before.start - back, nodes });
  }
  for (const [node, list] of edits) {
    // from the end, so the offsets ahead of each edit still hold; at one offset the wrap is made
    // first and the insert then lands before it, so what went reads before what replaced it
    list.sort((x, y) => y.start - x.start || (x.nodes ? 1 : 0) - (y.nodes ? 1 : 0));
    for (const edit of list) {
      if (edit.nodes) {
        node.splitText(edit.start).before(...edit.nodes);
        continue;
      }
      node.splitText(edit.end);
      const mid = node.splitText(edit.start);
      const wrap = mark();
      mid.replaceWith(wrap);
      wrap.append(mid);
    }
  }
}

/** mark both sides of an edited block in place: what went on the old, what came on the new */
function paintSides(o: Element, n: Element) {
  const [to, tn] = [tokensOf(o), tokensOf(n)];
  const gone: boolean[] = [];
  const came: boolean[] = [];
  for (const op of alignWords(to, tn)) {
    if (op.k === "gone") gone[op.o] = true;
    else if (op.k === "came") came[op.n] = true;
  }
  paint(o, to, gone, "del", GONE);
  paint(n, tn, came, "ins", CAME);
}

/** The tokens `first` to `last` of the old block as they were drawn, the marks over them kept.
 * A stretch that runs from one block into another (two items of a nested list) is taken as its
 * words alone: it is set into a line, where a block cannot stand. */
function lifted(root: Element, first: Token, last: Token): Element {
  const range = document.createRange();
  if ("el" in first) range.setStartBefore(first.el);
  else range.setStart(first.node, first.start);
  if ("el" in last) range.setEndAfter(last.el);
  else range.setEnd(last.node, last.end);
  const del = document.createElement("del");
  del.className = GONE;
  let body: Node = range.cloneContents();
  if (
    Array.from((body as DocumentFragment).querySelectorAll("*")).some(
      (el) => !INLINE.has(el.tagName) && !DRAWN.has(el.tagName),
    )
  ) {
    del.textContent = flat(body);
    return del;
  }
  let over: Node | null = range.commonAncestorContainer;
  if (over.nodeType === Node.TEXT_NODE) over = over.parentNode;
  for (; inline(over) && over !== root; over = over.parentNode) {
    const shell = over.cloneNode(false);
    shell.appendChild(body);
    body = shell;
  }
  del.append(body);
  return del;
}

/** an edited block as one: the new one, with what went set back in where it stood, struck */
function mergeWords(o: Element, n: Element): Element {
  const merged = n.cloneNode(true) as Element;
  const [to, tm] = [tokensOf(o), tokensOf(merged)];
  const ops = alignWords(to, tm);
  const came: boolean[] = [];
  const inserts: Insert[] = [];
  for (let x = 0, next = 0; x < ops.length; ) {
    const op = ops[x]!;
    if (op.k === "same") {
      next = op.n + 1;
      x++;
      continue;
    }
    const gone: number[] = [];
    for (; x < ops.length && ops[x]!.k !== "same"; x++) {
      const at = ops[x]!;
      if (at.k === "gone") gone.push(at.o);
      else if (at.k === "came") came[at.n] = true;
    }
    if (!gone.length) continue;
    const [first, last] = [gone[0]!, gone[gone.length - 1]!];
    const del = lifted(o, to[first]!, to[last]!);
    // It keeps the spacing it stood in. Where the seat is hard against the word ahead, or there
    // is no word ahead, its own space comes before it. Where the seat opens on a space, what stood
    // apart from the word behind sits after that space, with one of its own after it if it had
    // one (or if a word came in its place, which it never stood against); what stood hard against
    // the word behind, a comma, sits before the space.
    const before = tm[next];
    const apart = spaced(to, first);
    if (!before || !spaced(tm, next)) inserts.push({ before, nodes: apart ? [" ", del] : [del] });
    else if (apart) inserts.push({ before, nodes: spaced(to, last + 1) || came[next] ? [del, " "] : [del] });
    else {
      const lead = "node" in before ? before.start - before.node.data.slice(0, before.start).trimEnd().length : 0;
      inserts.push(lead ? { before, nodes: [del], back: lead } : { before, nodes: [del, " "] });
    }
  }
  paint(merged, tm, came, "ins", CAME, inserts);
  return merged;
}

/** mark both sides of an edited pair in place, as deep as its kind goes */
function markSides(o: Element, n: Element) {
  const kind = kindOf(o);
  if (kind === "leaf") {
    paintSides(o, n);
    return;
  }
  const [was, now] = [partsOf(o), partsOf(n)];
  for (const row of rowsOf(was, now)) {
    if (row.k === "gone") was[row.o]!.classList.add(GONE);
    else if (row.k === "came") now[row.n]!.classList.add(CAME);
    else if (row.k === "edit" && kind === "list") markSides(was[row.o]!, now[row.n]!);
    else if (row.k === "edit") {
      const [a, b] = [cellsOf(was[row.o]!), cellsOf(now[row.n]!)];
      a.forEach((cell, i) => {
        const other = b[i];
        if (other && cell.innerHTML !== other.innerHTML) paintSides(cell, other);
      });
    }
  }
}

/** an edited pair as one block: the new one, with the rows, items and words that went set back in */
function merge(o: Element, n: Element): Element {
  const kind = kindOf(o);
  if (kind === "leaf") return mergeWords(o, n);
  const merged = n.cloneNode(true) as Element;
  const [was, now, parts] = [partsOf(o), partsOf(n), partsOf(merged)];
  const rows = rowsOf(was, now);
  rows.forEach((row, x) => {
    if (row.k === "same") return;
    if (row.k === "came") {
      parts[row.n]!.classList.add(CAME);
      return;
    }
    if (row.k === "edit" && kind === "list") {
      parts[row.n]!.replaceWith(merge(was[row.o]!, now[row.n]!));
      return;
    }
    if (row.k === "edit") {
      const cells = cellsOf(was[row.o]!);
      cellsOf(parts[row.n]!).forEach((cell, i) => {
        const other = cells[i];
        if (other && other.innerHTML !== cell.innerHTML) cell.replaceWith(mergeWords(other, cell));
      });
      return;
    }
    // one that went stands before whatever follows it on the new side; a table's keeps to the
    // body, since a row set into the head would be drawn as a heading
    const gone = was[row.o]!.cloneNode(true) as Element;
    gone.classList.add(GONE);
    const next = rows.slice(x + 1).find((r): r is Exclude<Row, { k: "gone" }> => r.k !== "gone");
    const seat = next && parts[next.n];
    if (seat && seat.parentElement?.tagName !== "THEAD") seat.before(gone);
    else {
      const home = merged.querySelector("tbody") ?? merged.querySelector("table") ?? merged;
      if (seat) home.prepend(gone);
      else home.append(gone);
    }
  });
  return merged;
}

/** a page's blocks; text standing loose between them is a paragraph, so it is not dropped */
function blocksOf(html: string): Element[] {
  const page = document.createElement("template");
  page.innerHTML = html;
  return Array.from(page.content.childNodes).flatMap((node) => {
    if (node.nodeType === Node.ELEMENT_NODE) return [node as Element];
    if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) return [];
    const p = document.createElement("p");
    p.append(node);
    return [p];
  });
}

/**
 * The page `after` renders, marked with what changed since `before`; both are sanitized markdown
 * output, and so is what comes back. In one column the page is the new one with what went set
 * back in. With `split` it is the cells of a two-column grid, each odd one a piece of the page as
 * it was and the even one after it the same piece as it is, a row per block, so a block and its
 * other self share a top edge and the two scroll as one; a stretch that went and the one that
 * came in its place start on one line, as a hunk's two halves do in code.
 */
export function diffDocument(before: string, after: string, split: boolean): string {
  const olds = blocksOf(before);
  const news = blocksOf(after);
  const rows = rowsOf(olds, news);
  const out = document.createElement("div");
  if (!split) {
    for (const row of rows) {
      if (row.k === "edit") out.append(merge(olds[row.o]!, news[row.n]!));
      else if (row.k === "gone") {
        olds[row.o]!.classList.add(GONE);
        out.append(olds[row.o]!);
      } else {
        if (row.k === "came") news[row.n]!.classList.add(CAME);
        out.append(news[row.n]!);
      }
    }
    return out.innerHTML;
  }
  const pair = () => {
    const was = document.createElement("div");
    const now = document.createElement("div");
    out.append(was, now);
    return { was, now };
  };
  let hunk: ReturnType<typeof pair> | null = null;
  for (const row of rows) {
    if (row.k === "gone" || row.k === "came") {
      hunk ??= pair();
      if (row.k === "gone") {
        olds[row.o]!.classList.add(GONE);
        hunk.was.append(olds[row.o]!);
      } else {
        news[row.n]!.classList.add(CAME);
        hunk.now.append(news[row.n]!);
      }
      continue;
    }
    hunk = null;
    if (row.k === "edit") markSides(olds[row.o]!, news[row.n]!);
    const { was, now } = pair();
    was.append(olds[row.o]!);
    now.append(news[row.n]!);
  }
  return out.innerHTML;
}
