// Where an element is written when nothing on the page records it. A page built from strings, or a
// static one, has no fiber to read, so the picker sends what the element shows of itself (its id,
// classes, own text and hand-written attributes) and the source is searched for those. Pure, so the
// ranking is tested against grep rows with no repo; files/service.ts runs the grep.

import type { ElementTraits, SearchHit } from "@toyon/shared";

/** one trait to search for, and what finding it is worth before rarity */
export interface Needle {
  text: string;
  weight: number;
  /** an id or a class is a name of its own: `content` inside `app-content` is another class */
  word: boolean;
}

export interface ElementSources {
  /** best first, one line per place */
  hits: SearchHit[];
  /** the first hit is clearly the element, so it can open without asking */
  sure: boolean;
}

/** a trait on more lines than this could be any of them */
const COMMON = 40;
/** one tag is often written over a few lines: its classes on one, its text on the next */
const NEAR = 3;
/** how far ahead the best place has to be to open without a list */
const CLEAR_LEAD = 1.5;
/** the most places offered when no one of them is clearly the element */
export const ELEMENT_SOURCES_MAX = 8;

const NAME = /^[\w-]+$/;
const TAG = /^[a-z][a-z0-9-]*$/;
const NAME_CHAR = /[\w-]/;

export function needlesOf(el: ElementTraits): Needle[] {
  const out = new Map<string, Needle>();
  const add = (text: string, weight: number, word: boolean) => {
    if (text.length < 2 || /[\r\n]/.test(text)) return;
    const had = out.get(text);
    if (!had || had.weight < weight) out.set(text, { text, weight, word });
  };
  if (el.id) add(el.id, 8, NAME.test(el.id));
  // text is written as it reads only up to the first thing a template or an entity would change
  const words = (el.text.split(/[&<>"'`${}]/)[0] ?? "").trim().split(/\s+/).slice(0, 6).join(" ");
  if (words.length >= 3 && /\p{L}/u.test(words)) add(words, 6, false);
  for (const [, value] of el.attrs) add(value, 5, NAME.test(value));
  for (const c of el.classes) add(c, 3, true);
  return [...out.values()];
}

function carries(line: string, n: Needle): boolean {
  if (!n.word) return line.includes(n.text);
  for (let i = line.indexOf(n.text); i >= 0; i = line.indexOf(n.text, i + 1)) {
    const before = line[i - 1];
    const after = line[i + n.text.length];
    if (!(before && NAME_CHAR.test(before)) && !(after && NAME_CHAR.test(after))) return true;
  }
  return false;
}

/** the line opens the tag itself, as markup or through the DOM, rather than naming the element to
 * find it (`getElementById`, a selector) */
function writesTag(line: string, tag: string): boolean {
  if (!TAG.test(tag)) return false;
  return new RegExp(`<${tag}(?:[\\s>/]|$)|createElement\\(\\s*["'\`]${tag}["'\`]`, "i").test(line);
}

export function rankElementSources(el: ElementTraits, rows: SearchHit[]): ElementSources {
  const needles = needlesOf(el);
  const on = rows.map((r) => needles.map((n) => carries(r.text, n)));
  // a trait is worth less the more lines carry it, and nothing once it could be anywhere
  const worth = needles.map((n, k) => {
    const lines = on.filter((f) => f[k]).length;
    return lines === 0 || lines > COMMON ? 0 : n.weight / Math.sqrt(lines);
  });
  const byFile = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const list = byFile.get(r.path);
    if (list) list.push(i);
    else byFile.set(r.path, [i]);
  });

  const scored: Array<{ hit: SearchHit; score: number }> = [];
  rows.forEach((r, i) => {
    const counted = needles.map((_, k) => !!on[i]?.[k] && (worth[k] ?? 0) > 0);
    if (!counted.some(Boolean)) return;
    let score = 0;
    counted.forEach((c, k) => {
      if (c) score += worth[k] ?? 0;
    });
    // the rest of the same tag, written on the lines around it, counts for half
    for (const j of byFile.get(r.path) ?? []) {
      const near = rows[j];
      if (j === i || !near || Math.abs(near.line - r.line) > NEAR) continue;
      needles.forEach((_, k) => {
        if (counted[k] || !on[j]?.[k] || !worth[k]) return;
        score += worth[k] / 2;
        counted[k] = true;
      });
    }
    if (writesTag(r.text, el.tag)) score *= 2;
    scored.push({ hit: r, score });
  });

  scored.sort((a, b) => b.score - a.score || a.hit.path.localeCompare(b.hit.path) || a.hit.line - b.hit.line);
  // the lines of one tag are one place, offered once at its best line
  const kept: typeof scored = [];
  for (const s of scored) {
    if (kept.some((k) => k.hit.path === s.hit.path && Math.abs(k.hit.line - s.hit.line) <= NEAR)) continue;
    kept.push(s);
    if (kept.length === ELEMENT_SOURCES_MAX) break;
  }
  const [best, next] = kept;
  return {
    hits: kept.map((k) => ({ ...k.hit, text: k.hit.text.trim().slice(0, 200) })),
    sure: !!best && (!next || best.score >= next.score * CLEAR_LEAD),
  };
}
