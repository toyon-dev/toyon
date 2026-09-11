// Which pages a repo's previews are used on, ranked the way an address bar ranks them: often and
// recently together. Pure: the service holds the record and the clock.

import type { PageEntry } from "@toyon/shared";

/** one page's standing: a count that halves every HALF_LIFE_MS, as of `last`, and its title */
export interface Visit {
  score: number;
  last: number;
  title?: string;
}

/** A page visited every day holds its place; one you stopped visiting falls below this morning's
 * two visits within the week. */
export const HALF_LIFE_MS = 3 * 24 * 60 * 60 * 1000;
/** kept per repo, and sent whole; past this the weakest page is dropped */
export const KEEP = 100;

export function decayed(v: Visit, now: number): number {
  return v.score * 0.5 ** (Math.max(0, now - v.last) / HALF_LIFE_MS);
}

/** three decimals: the file is read by people too, and the tail past that ranks nothing */
const rounded = (n: number) => Math.round(n * 1000) / 1000;

/** Count a visit to `key`, keeping the title it had unless a new one came with the visit. Mutates
 * `pages`, which is the state store's live record, and drops the weakest other page past KEEP. */
export function bump(pages: Record<string, Visit>, key: string, now: number, title?: string): void {
  const v = pages[key];
  const named = title ?? v?.title;
  pages[key] = { score: rounded((v ? decayed(v, now) : 0) + 1), last: now, ...(named ? { title: named } : {}) };
  const keys = Object.keys(pages);
  if (keys.length <= KEEP) return;
  const weakest = keys
    .filter((k) => k !== key)
    .sort(byStanding(pages, now))
    .at(-1);
  if (weakest) delete pages[weakest];
}

/** name a page without counting a visit; false when it is not on the list or already has that title */
export function retitle(pages: Record<string, Visit>, key: string, title: string): boolean {
  const v = pages[key];
  if (!v || v.title === title) return false;
  v.title = title;
  return true;
}

/** the `n` strongest pages, best first; a tie goes to the one visited last */
export function rank(pages: Record<string, Visit>, now: number, n = KEEP): string[] {
  return Object.keys(pages).sort(byStanding(pages, now)).slice(0, n);
}

/** every kept page as the shell is sent it, best first, scored as of `now` */
export function entries(pages: Record<string, Visit>, now: number): PageEntry[] {
  return rank(pages, now).map((path) => {
    const v = pages[path]!;
    return { path, score: rounded(decayed(v, now)), last: v.last, ...(v.title ? { title: v.title } : {}) };
  });
}

const byStanding = (pages: Record<string, Visit>, now: number) => (a: string, b: string) =>
  decayed(pages[b]!, now) - decayed(pages[a]!, now) || pages[b]!.last - pages[a]!.last;
