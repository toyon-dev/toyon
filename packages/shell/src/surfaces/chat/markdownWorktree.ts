import type { ArchivedWorktree, OwnedWorktree } from "@toyon/shared";
import type { TokenizerAndRendererExtension } from "marked";
import type { State } from "../../state/store.ts";
import { escapeHtml } from "./markdownHtml.ts";

/** a worktree of the project as the agent's prose can name it: by its directory, `wt-xxxx`, which
 * is what its cwd, a transcript path and a log line all spell, and the row it is */
export interface NamedWorktree {
  dir: string;
  id: string;
  title: string;
  branch: string;
  /** the row is in the archive, so a press opens its page rather than activating it */
  archived?: true;
}

export type WorktreeNamer = (dir: string) => NamedWorktree | null;

const dirOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** the project's rows and archived worktrees by directory, live rows first: a row brought back
 * from the archive is a row, whatever record the archive still holds for its directory */
export function worktreeNames(
  rows: readonly OwnedWorktree[],
  archived: readonly ArchivedWorktree[] | undefined,
  repoId: string,
): NamedWorktree[] {
  const out: NamedWorktree[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const w = r.worktree;
    if (w.repoId !== repoId) continue;
    const dir = dirOf(w.path);
    if (seen.has(dir)) continue;
    seen.add(dir);
    out.push({ dir, id: w.id, title: w.title, branch: w.branch });
  }
  for (const a of archived ?? []) {
    const dir = dirOf(a.path);
    if (a.repoId !== repoId || seen.has(dir)) continue;
    seen.add(dir);
    out.push({ dir, id: a.id, title: a.title, branch: a.branch, archived: true });
  }
  return out;
}

const keyCache = new WeakMap<
  readonly OwnedWorktree[],
  Map<string, { archived: readonly ArchivedWorktree[] | undefined; key: string }>
>();

/** The names as one string, so a selector over the store settles: the rows are a fresh array on
 * every status tick while the names on them hardly move, and every message of a long chat reads
 * this once a tick. Built once per rows array and archive list, whichever changed. */
export function namesKey(s: Pick<State, "visible" | "archived">, repoId: string): string {
  let byRepo = keyCache.get(s.visible);
  if (!byRepo) {
    byRepo = new Map();
    keyCache.set(s.visible, byRepo);
  }
  const archived = s.archived[repoId];
  const hit = byRepo.get(repoId);
  if (hit && hit.archived === archived) return hit.key;
  const key = JSON.stringify(worktreeNames(s.visible, archived, repoId));
  byRepo.set(repoId, { archived, key });
  return key;
}

/** the names back from their key, as the lookup a render asks */
export function namerFrom(key: string): WorktreeNamer {
  const byDir = new Map<string, NamedWorktree>();
  for (const n of JSON.parse(key) as NamedWorktree[]) byDir.set(n.dir, n);
  return (dir) => byDir.get(dir) ?? null;
}

const ID = "wt-[0-9a-f]{4}";
// a directory name on its own, bare or in a code span of its own: not the tail of a longer word,
// not a segment of a path (which stays the path it is), not part of a longer span
const START = new RegExp(`(^|[^\\w\\-/\`])\`?${ID}(?![\\w\\-/\`])`);
const TOKEN = new RegExp(`^(\`?)(${ID})\\1(?![\\w\\-/\`])`);

const attr = (s: string) => escapeHtml(s).replace(/"/g, "&quot;");

/** `wt-xxxx` in the agent's prose, drawn as the row it names: `@branch`, the mark the person's
 * own reference to a row wears on their side of the transcript, so both sides say one thing
 * about a worktree, and the title in the tip. The agent's cwd and every path it reads spell a
 * worktree by its directory, so the id leaks into its replies however it is told to use names.
 * A press opens the row. A directory no row or archived record has stays as written, backticks
 * and all. The namer is read at render, since the names come with the row. */
export function worktreeMention(namer: () => WorktreeNamer | undefined): TokenizerAndRendererExtension {
  return {
    name: "worktree",
    level: "inline",
    start: (src) => {
      const m = START.exec(src);
      return m ? m.index + m[1]!.length : undefined;
    },
    tokenizer(src) {
      const m = TOKEN.exec(src);
      if (!m) return undefined;
      return { type: "worktree", raw: m[0], text: m[2], code: m[1] !== "" };
    },
    renderer(token) {
      const dir = token.text as string;
      const named = namer()?.(dir) ?? null;
      if (!named) return token.code ? `<code>${dir}</code>` : dir;
      const tip = `the chat of "${named.title}" (${dir}${named.archived ? ", archived" : ""})`;
      const archived = named.archived ? ' data-archived=""' : "";
      return `<span class="chat-mention" data-worktree="${attr(named.id)}" data-branch="${attr(named.branch)}"${archived} data-tip="${attr(tip)}" data-tip-placement="follow">@${escapeHtml(named.branch)}</span>`;
    },
  };
}
