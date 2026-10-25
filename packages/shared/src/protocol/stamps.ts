// The stamps a page echoes back to say what it already holds. The daemon stamps each part of the
// hello it may leave out (rows with their trunks, repos, visits, themes) with a hash of the frame
// it sent, and every frame that moves one of them carries the new stamp. The page keeps the latest
// of each and sends them on the socket URL as `known`; a part it cannot vouch for is empty, and an
// empty part never matches. Pure and zod-free: both ends read it, and the shell's socket URL is
// built before anything else loads.

/** the hash of each part of the hello the page may already hold, as the daemon last sent it */
export interface Stamps {
  /** the rows and the trunks beside them: a `worktrees` frame */
  rows: string;
  repos: string;
  /** every repo's history, whole: a `visits` frame carries one repo and stamps them all */
  visits: string;
  themes: string;
}

export const STAMP_PARTS = ["rows", "repos", "visits", "themes"] as const satisfies readonly (keyof Stamps)[];

/** a stamp as the daemon writes it: hex, so the four join on a dot without ambiguity */
const PART = /^[0-9a-f]*$/;

/** the `known` query value: the four parts on dots, an empty part for one the page cannot vouch for */
export function encodeKnown(parts: Partial<Stamps>): string {
  return STAMP_PARTS.map((p) => parts[p] ?? "").join(".");
}

/** the `known` a socket opened with; null when it carried none, or not four hex parts */
export function parseKnown(q: string | null | undefined): Stamps | null {
  if (!q) return null;
  const parts = q.split(".");
  if (parts.length !== STAMP_PARTS.length || !parts.every((p) => p.length <= 32 && PART.test(p))) return null;
  return { rows: parts[0]!, repos: parts[1]!, visits: parts[2]!, themes: parts[3]! };
}

/** whether a part the page holds is the one the daemon has now; an empty part is never a match */
export const sameStamp = (held: string, now: string): boolean => held !== "" && held === now;
