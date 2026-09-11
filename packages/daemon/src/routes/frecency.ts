// Which pages a repo's previews are used on, ranked the way an address bar ranks them: often and
// recently together. Pure: the service holds the record and the clock.

/** one page's standing: a count that halves every HALF_LIFE_MS, as of `last` */
export interface Visit {
  score: number;
  last: number;
}

/** A page visited every day holds its place; one you stopped visiting falls below this morning's
 * two visits within the week. */
export const HALF_LIFE_MS = 3 * 24 * 60 * 60 * 1000;
/** kept per repo; past this the weakest page is dropped */
export const KEEP = 100;
/** what the shell is sent */
export const SHOWN = 20;

export function decayed(v: Visit, now: number): number {
  return v.score * 0.5 ** (Math.max(0, now - v.last) / HALF_LIFE_MS);
}

/** count a visit to `key`. Mutates `pages`, which is the state store's live record, and drops the
 * weakest other page once the record passes KEEP. */
export function bump(pages: Record<string, Visit>, key: string, now: number): void {
  const v = pages[key];
  // three decimals: the file is read by people too, and the tail past that ranks nothing
  pages[key] = { score: Math.round(((v ? decayed(v, now) : 0) + 1) * 1000) / 1000, last: now };
  const keys = Object.keys(pages);
  if (keys.length <= KEEP) return;
  const weakest = keys
    .filter((k) => k !== key)
    .sort(byStanding(pages, now))
    .at(-1);
  if (weakest) delete pages[weakest];
}

/** the `n` strongest pages, best first; a tie goes to the one visited last */
export function rank(pages: Record<string, Visit>, now: number, n = SHOWN): string[] {
  return Object.keys(pages).sort(byStanding(pages, now)).slice(0, n);
}

const byStanding = (pages: Record<string, Visit>, now: number) => (a: string, b: string) =>
  decayed(pages[b]!, now) - decayed(pages[a]!, now) || pages[b]!.last - pages[a]!.last;
