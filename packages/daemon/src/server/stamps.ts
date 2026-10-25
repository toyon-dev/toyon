// What the daemon stamps a hello's parts with, and the hello a socket gets for what it said it
// already holds. A stamp is a hash of the part as serialized for the wire, so two frames that
// would read the same stamp the same; the frames that move a part carry its stamp (ws.ts), the
// page echoes the latest of each as `known`, and the hello here leaves out what still matches.

import type { PageEntry } from "@toyon/shared";
import {
  type HelloFull,
  type HelloMsg,
  type RepoInfo,
  type Stamps,
  sameStamp,
  type Theme,
  type TrunkStatus,
  type WorktreeStatus,
} from "@toyon/shared";

/** the stamp of one part: wyhash of the JSON it goes out as, which is what the page holds */
export const stampOf = (part: unknown): string => Bun.hash(JSON.stringify(part)).toString(16);

/** The visits stamped by what the list shows, order and titles, never the scores: a score decays
 * with the clock, so the same history read twice a minute apart would stamp apart and no page
 * with a route history would ever match. The route service announces a change by the same rule. */
export const visitsStamp = (visits: Record<string, PageEntry[]>): string =>
  stampOf(Object.entries(visits).map(([repoId, list]) => [repoId, list.map((e) => [e.path, e.title ?? ""])]));

/** the stamps of a hello's parts; the rows and their trunks are one part, as one frame moves them */
export function stampsOf(h: {
  rows: WorktreeStatus[];
  trunks: Record<string, TrunkStatus>;
  repos: RepoInfo[];
  visits: Record<string, PageEntry[]>;
  themes: Theme[];
}): Stamps {
  return {
    rows: stampOf({ rows: h.rows, trunks: h.trunks }),
    repos: stampOf(h.repos),
    visits: visitsStamp(h.visits),
    themes: stampOf(h.themes),
  };
}

/** The hello for a socket that opened with `known`: the full one less the themes when those
 * match, and the `same` shape when rows, repos and visits all do. A socket with no `known` holds
 * nothing and gets everything. */
export function shapeHello(full: HelloFull, known: Stamps | null): HelloMsg {
  if (!known) return full;
  const { themes, ...rest } = full;
  const withThemes = sameStamp(known.themes, full.stamps.themes) ? rest : full;
  const same =
    sameStamp(known.rows, full.stamps.rows) &&
    sameStamp(known.repos, full.stamps.repos) &&
    sameStamp(known.visits, full.stamps.visits);
  if (!same) return withThemes;
  const { rows: _r, trunks: _t, repos: _p, visits: _v, same: _s, ...light } = withThemes;
  return { ...light, same: true };
}
