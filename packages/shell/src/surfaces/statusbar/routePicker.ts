// The route bar's rows: what a person expects to see when they click the address. Pure, so every
// ordering rule is tested without a DOM.
//
// Untouched, the list is short and in one piece: pages the agent added or changed that you have not
// opened since, then the pages you use (one row per template, however many ids you visited), then
// the app's other pages to fill what is left. Typed, it searches all of them by path and title, with
// path prefixes first so tab has something to complete.

import {
  compileRoute,
  type PageBadge,
  type PageEntry,
  type PageLink,
  type RouteInfo,
  type Template,
  templateFor,
  templateText,
  type WorktreePages,
} from "@toyon/shared";
import type { Completion } from "../../ui/listNav.ts";
import { humanize, pageTitles } from "./pageTitle.ts";

/** rows in the untouched list: enough to be useful, few enough to read at a glance */
export const UNTOUCHED_MAX = 8;
/** rows of your own history kept however many pages changed */
const HISTORY_RESERVE = 3;
export const TYPED_MAX = 50;
/** visited ids listed under one template, until the query reaches into its parameter */
const PER_TEMPLATE = 3;

export type Row =
  | { kind: "go"; path: string; title: string }
  | {
      kind: "page";
      path: string;
      title: string;
      /** a route with a parameter: enter fills it in rather than going there */
      template: boolean;
      /** on the repo's history, so it can be taken off it */
      visited: boolean;
      file?: string;
      badge?: PageBadge;
    };

type PageRow = Extract<Row, { kind: "page" }>;
type Candidate = PageRow & { rank: number; group: string; score: number };

/** everything the rows are made from, worked out once per history and pages */
export interface PageModel {
  history: PageEntry[];
  statics: Map<string, RouteInfo>;
  templates: Template[];
  templateRoutes: Map<string, RouteInfo>;
  unseen: Record<string, PageBadge>;
  titles: Map<string, string>;
  /** links the preview's pages showed, by path to what they said: an app with no route table's pages */
  links: Map<string, string>;
}

export function pageModel(history: PageEntry[], pages: WorktreePages | undefined, links: PageLink[] = []): PageModel {
  const statics = new Map<string, RouteInfo>();
  const templates: Template[] = [];
  const templateRoutes = new Map<string, RouteInfo>();
  for (const route of pages?.routes ?? []) {
    if (route.endpoint) continue;
    const template = route.dynamic ? compileRoute(route.path) : null;
    if (template) {
      templates.push(template);
      templateRoutes.set(route.path, route);
    } else statics.set(route.path, route);
  }
  return {
    history,
    statics,
    templates,
    templateRoutes,
    unseen: pages?.unseen ?? {},
    titles: pageTitles(history),
    links: new Map(links.map((l) => [l.path, l.text])),
  };
}

/** the address as the bar shows it: path, query and hash, since a hash router's route is its hash */
export function pathOf(url: string | undefined): string {
  if (!url) return "/";
  try {
    const u = new URL(url);
    return u.pathname + u.search + u.hash;
  } catch {
    return "/";
  }
}

/** where a typed path navigates: "/path", "?query" and "#/hash-route" are valid as typed, and
 * anything else is a path */
export function normalizePath(q: string): string {
  const t = q.trim();
  return /^[/?#]/.test(t) ? t : `/${t}`;
}

/** what a row completes the query to, in the form it was typed: with the slash when it was typed
 * with one, without when it was not, so the ghost lines up with the caret */
export function completionFor(path: string, q: string): string | null {
  const c = /^[/?#]/.test(q) ? path : path.replace(/^\//, "");
  return q && c.toLowerCase().startsWith(q.toLowerCase()) ? c : null;
}

const isSplat = (seg: string) => /^\[\[?\.\.\.|^\*$|^\$$/.test(seg);
const isParam = (seg: string) => isSplat(seg) || (/[[:$*{]/.test(seg) && !/^[^[{:$*]+\?$/.test(seg));
const wordOf = (seg: string) => templateText(`/${seg}`).text.slice(1);
const segmentsOf = (path: string) => path.split("/").filter(Boolean);

/**
 * A template walked alongside what was typed. Each segment typed in full must be the template's literal
 * segment or fill a parameter; the one being typed must start a literal segment or sit in a
 * parameter. What is left of the template is shown after it, each parameter as its placeholder word,
 * and tab takes the literal text up to the next one. Null when the query leaves the template.
 */
function walk(path: string, q: string): Completion | null {
  const slash = q.startsWith("/");
  const typed = q.replace(/^\//, "").split("/");
  const segs = segmentsOf(path);
  let out = "";
  const params: Array<[number, number]> = [];
  const placeholder = (seg: string) => {
    const word = wordOf(seg);
    params.push([out.length, out.length + word.length]);
    out += word;
  };
  for (let i = 0; i < typed.length; i++) {
    const part = typed[i]!;
    const seg = segs[i];
    if (seg === undefined) return null;
    if (i < typed.length - 1) {
      if (isSplat(seg)) return { show: q, accept: q };
      if (isParam(seg)) {
        if (!part) return null;
      } else if (part.toLowerCase() !== seg.toLowerCase()) return null;
      out += `${isParam(seg) ? part : seg}/`;
      continue;
    }
    if (isParam(seg)) {
      if (part) out += part;
      else placeholder(seg);
    } else {
      if (!seg.toLowerCase().startsWith(part.toLowerCase())) return null;
      out += seg;
    }
  }
  for (const seg of segs.slice(typed.length)) {
    out += "/";
    if (isParam(seg)) placeholder(seg);
    else out += seg;
  }
  const shift = slash ? 1 : 0;
  const show = (slash ? "/" : "") + out;
  const first = params[0];
  return {
    show,
    accept: first ? show.slice(0, first[0] + shift) : show,
    params: params.map(([a, b]): [number, number] => [a + shift, b + shift]),
  };
}

/** what enter on a template puts in the field: what tab would take, or the literal text before its
 * first parameter when what was typed is not on the way to it */
export function fillTemplate(path: string, q: string): string {
  const c = walk(path, q);
  if (!c) return templateText(path).literal;
  return c.accept.length > q.length ? c.accept : q;
}

/** the ghost after the caret for a highlighted row: a path it extends, or a template's shape */
export function completionOf(row: Row, q: string): string | Completion | null {
  if (row.kind === "go") return null;
  if (row.template) {
    const c = walk(row.path, q);
    return c && c.show.length > q.length ? c : null;
  }
  return completionFor(row.path, q);
}

const needleOf = (q: string) => q.trim().replace(/^\//, "").toLowerCase();

/** where `n` starts right after a separator in `text` */
function boundaryPrefix(text: string, n: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if ("/-_.#".includes(text[i]!) && text.startsWith(n, i + 1)) return true;
  }
  return false;
}

/** how well a page answers the query: its own path first, then a word of it, then its title */
function scorePage(path: string, title: string, n: string): number {
  const p = path.replace(/^\//, "").toLowerCase();
  const t = title.toLowerCase();
  if (p === n) return 100;
  if (p.startsWith(n)) return 80;
  if (boundaryPrefix(p, n)) return 60;
  if (t.startsWith(n)) return 50;
  if (t.split(/\s+/).some((w) => w.startsWith(n))) return 45;
  if (p.includes(n) || t.includes(n)) return 20;
  return 0;
}

/** how well a template answers the query; under 60 it is not worth a row */
function scoreTemplate(path: string, n: string): number {
  const { text, literal } = templateText(path);
  if (literal.replace(/^\//, "").toLowerCase().startsWith(n)) return 80;
  if (walk(path, n)) return 70;
  if (boundaryPrefix(text.replace(/^\//, "").toLowerCase(), n)) return 60;
  return 0;
}

/** the query has got as far as the template's first parameter */
function reachesParam(path: string, n: string): boolean {
  const first = segmentsOf(path).findIndex(isParam);
  return first >= 0 && n.split("/").length > first;
}

function pageRow(m: PageModel, path: string, rank: number): Candidate {
  const own = m.statics.get(path);
  const template = own ? null : templateFor(m.templates, path);
  const file = own?.file ?? (template ? m.templateRoutes.get(template.path)?.file : undefined);
  const badge = file ? m.unseen[file] : undefined;
  return {
    kind: "page",
    path,
    // the page's own title, else what a link to it said, else a word from its path
    title: m.titles.get(path) || m.links.get(path) || humanize(path),
    template: false,
    visited: rank < Number.POSITIVE_INFINITY,
    ...(file ? { file } : {}),
    ...(badge ? { badge } : {}),
    rank,
    group: template?.path ?? path,
    score: 0,
  };
}

function templateRow(m: PageModel, route: RouteInfo): Candidate {
  const badge = m.unseen[route.file];
  return {
    kind: "page",
    path: route.path,
    title: humanize(route.path),
    template: true,
    visited: false,
    file: route.file,
    ...(badge ? { badge } : {}),
    rank: Number.POSITIVE_INFINITY,
    group: route.path,
    score: 0,
  };
}

function strip({ rank: _rank, group: _group, score: _score, ...row }: Candidate): Row {
  return row;
}

const depth = (path: string) => segmentsOf(path).length;
const badgeOrder = (c: Candidate) => (c.badge === "new" ? 0 : c.badge === "changed" ? 1 : 2);

function untouchedRows(m: PageModel, here: string | null): Row[] {
  // your history, the page on screen left out before ids gather under their template, so another
  // id of the same page can stand for it
  const groups = new Set<string>();
  const history: Candidate[] = [];
  m.history.forEach((entry, rank) => {
    if (entry.path === here) return;
    const c = pageRow(m, entry.path, rank);
    if (groups.has(c.group)) return;
    groups.add(c.group);
    history.push(c);
  });
  const listed = new Set(history.map((c) => c.path));
  const badged = history.filter((c) => c.badge);
  for (const [path, route] of m.statics) {
    if (m.unseen[route.file] && path !== here && !listed.has(path))
      badged.push(pageRow(m, path, Number.POSITIVE_INFINITY));
  }
  for (const route of m.templateRoutes.values()) {
    // a changed template shows as the id you last visited under it, or as itself with a placeholder
    if (m.unseen[route.file] && !groups.has(route.path)) badged.push(templateRow(m, route));
  }
  badged.sort((a, b) => badgeOrder(a) - badgeOrder(b) || a.rank - b.rank);
  const plain = history.filter((c) => !c.badge);
  const rows = badged.slice(0, UNTOUCHED_MAX - Math.min(HISTORY_RESERVE, plain.length));
  for (const c of plain) if (rows.length < UNTOUCHED_MAX) rows.push(c);
  const shown = new Set(rows.map((r) => r.path));
  // the app's pages, and then, for an app with no route table, the pages its links led to
  const fill = [...m.statics.keys(), ...[...m.links.keys()].filter((path) => !m.statics.has(path))]
    .filter((path) => path !== here && !shown.has(path) && !listed.has(path))
    .sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0));
  for (const path of fill) {
    if (rows.length >= UNTOUCHED_MAX) break;
    rows.push(pageRow(m, path, Number.POSITIVE_INFINITY));
  }
  return rows.map(strip);
}

function typedRows(m: PageModel, query: string, here: string | null): Row[] {
  const n = needleOf(query);
  const goPath = normalizePath(query);
  const pages = new Map<string, Candidate>();
  m.history.forEach((entry, rank) => {
    if (entry.path !== here) pages.set(entry.path, pageRow(m, entry.path, rank));
  });
  for (const path of [...m.statics.keys(), ...m.links.keys()]) {
    if (path !== here && !pages.has(path)) pages.set(path, pageRow(m, path, Number.POSITIVE_INFINITY));
  }
  const scored: Candidate[] = [];
  for (const c of pages.values()) {
    const score = scorePage(c.path, c.title, n);
    if (score > 0) scored.push({ ...c, score });
  }
  // a query that fills a template in completely is a place: it leads as a go row, and the template does not
  let filled: RouteInfo | null = null;
  for (const t of m.templates) {
    const route = m.templateRoutes.get(t.path)!;
    if (!filled && !m.statics.has(goPath) && t.re.test(goPath)) {
      filled = route;
      continue;
    }
    const score = scoreTemplate(t.path, n);
    if (score >= 60) scored.push({ ...templateRow(m, route), score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.rank - b.rank ||
      badgeOrder(a) - badgeOrder(b) ||
      depth(a.path) - depth(b.path) ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  const perTemplate = new Map<string, number>();
  const rows: Candidate[] = [];
  for (const c of scored) {
    if (!c.template && c.group !== c.path) {
      const count = perTemplate.get(c.group) ?? 0;
      if (count >= PER_TEMPLATE && !reachesParam(c.group, n)) continue;
      perTemplate.set(c.group, count + 1);
    }
    rows.push(c);
    if (rows.length >= TYPED_MAX) break;
  }
  if (rows.some((r) => r.score === 100)) return rows.map(strip);
  const go: Row = { kind: "go", path: goPath, title: humanize(filled?.path ?? goPath) };
  // a path that leads with a prefix match keeps the highlight, so tab's ghost stays on it
  return filled || (rows[0]?.score ?? 0) < 80 ? [go, ...rows.map(strip)] : [...rows.map(strip), go];
}

/**
 * The rows for what is in the field. The field opens holding the page's own address, selected, and
 * that address (or nothing) is the untouched list rather than a filter. The page on screen is never
 * a row: going there is what reload is for.
 */
export function rowsFor(
  m: PageModel,
  { query, current, here }: { query: string; current: string; here: string | null },
): Row[] {
  return query === current || query.trim() === "" ? untouchedRows(m, here) : typedRows(m, query, here);
}
