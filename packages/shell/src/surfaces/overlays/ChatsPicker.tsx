import { type ArchivedWorktree, type ChatHit, isMain, type OwnedWorktree } from "@toyon/shared";
import { useCallback, useEffect, useMemo } from "react";
import { archivedHint } from "../../state/actions/archive.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { useVisibleArchived, useVisibleWorktrees } from "../../state/selectors.ts";
import { markHits } from "../../ui/highlight.tsx";
import { ListPicker } from "../../ui/ListPicker.tsx";
import { ago } from "../util.ts";
import { PaletteRow } from "./PaletteRow.tsx";
import "./chats.css";

/** a query this short matches nearly every message, and the daemon answers nothing under it */
const MIN = 2;

/** a worktree whose name or branch has the query in it, listed above the hits: typing a branch's name
 * finds its chat though nothing in the chat says it. Not its first message, which is a hit already:
 * the same words twice would put the row that opens no message above the one that does. */
type WorktreeRow = { kind: "worktree"; id: string; name: string; archived: boolean; hint: string; fields: string[] };
type ChatsRow = WorktreeRow | { kind: "hit"; hit: ChatHit };

const NONE: ChatsRow[] = [];

const liveRow = (w: OwnedWorktree): WorktreeRow => ({
  kind: "worktree",
  id: w.id,
  name: w.name,
  archived: false,
  hint: w.branch ?? "",
  fields: [w.name, w.branch ?? ""],
});

const archivedRow = (a: ArchivedWorktree): WorktreeRow => ({
  kind: "worktree",
  id: a.id,
  name: a.title,
  archived: true,
  hint: archivedHint(a),
  fields: [a.title, a.branch],
});

/** the indexes markHits lights, from a hit's start and length */
const charsOf = ([start, length]: [number, number]) => Array.from({ length }, (_, i) => start + i);

/** ⌘G: what the project's chats say. ⌘F finds in the chat on screen; this looks through every
 * worktree's, the archived ones too, since "where did I ask for that" is mostly asked after the
 * branch has landed. A hit opens its chat with the message marked and brought up. */
export function ChatsPicker({ repoId }: { repoId: string }) {
  const dispatch = useDispatch();
  const sock = useSock();
  const results = useStore((s) => s.chats[repoId]);
  const live = useVisibleWorktrees();
  const archived = useVisibleArchived();
  // asked for on open, as the archive picker does: an archived hit needs the list to open its page
  useEffect(() => {
    sock?.send({ t: "list-archived", repoId });
  }, [sock, repoId]);
  // main has no chat of its own, so it is never a place to look
  const worktrees = useMemo(
    () => [...live.filter((w) => !isMain(w.worktree)).map(liveRow), ...archived.map(archivedRow)],
    [live, archived],
  );
  const names = useMemo(() => new Map(worktrees.map((w) => [w.id, w.name])), [worktrees]);
  const items = useMemo(
    (): ChatsRow[] => [...worktrees, ...(results?.hits ?? []).map((hit) => ({ kind: "hit" as const, hit }))],
    [worktrees, results],
  );
  // the hits are the daemon's answer, shown as they came; the worktrees are matched here
  const filter = useCallback((rows: ChatsRow[], q: string) => {
    const needle = q.trim().toLowerCase();
    if (needle.length < MIN) return NONE;
    return rows.filter((r) => r.kind === "hit" || r.fields.some((f) => f.toLowerCase().includes(needle)));
  }, []);
  const onQuery = useCallback(
    (q: string) => {
      const t = q.trim();
      if (t.length >= MIN) sock?.send({ t: "search-chats", repoId, query: t });
    },
    [sock, repoId],
  );
  // stale = the daemon has not answered this query yet; the previous hits stay up meanwhile
  const isStale = (q: string) => !results || results.query !== q.trim();
  return (
    <ListPicker
      items={items}
      filter={filter}
      onQuery={onQuery}
      keyOf={(r) => (r.kind === "hit" ? `h:${r.hit.worktreeId}:${r.hit.seq}` : `w:${r.id}`)}
      rowClass={(r) => (r.kind === "hit" ? "chats-hit" : "picker-row")}
      rowTitle={(r) => (r.kind === "hit" ? r.hit.text : undefined)}
      onPick={(r) => {
        const id = r.kind === "hit" ? r.hit.worktreeId : r.id;
        const gone = r.kind === "hit" ? r.hit.archived : r.archived;
        dispatch(gone ? { a: "open-archived", id } : { a: "activate", id });
        if (r.kind === "hit") dispatch({ a: "reveal", id, seq: r.hit.seq });
        dispatch({ a: "close" });
      }}
      onBack={() => dispatch({ a: "close" })}
      placeholder="search in chats…"
      keys={(active) => ({
        nav: "moves",
        pick: active ? (active.kind === "hit" ? "opens the chat there" : "opens its chat") : undefined,
        back: "closes",
      })}
      empty={(q) =>
        q.trim().length < MIN ? "type at least two characters" : isStale(q) ? "searching…" : "no chat says that"
      }
      footer={(q, rows) => {
        const hits = rows.filter((r) => r.kind === "hit").length;
        return results?.truncated && !isStale(q) && hits > 0 ? (
          <div className="empty">showing the first {hits}; narrow the search</div>
        ) : null;
      }}
      row={(r) =>
        r.kind === "worktree" ? (
          <PaletteRow
            label={
              r.archived ? (
                <>
                  {r.name} <span className="row-dim">archived</span>
                </>
              ) : (
                r.name
              )
            }
            hint={r.hint}
          />
        ) : (
          <>
            <span className="chats-where">
              <span className="chats-name">{names.get(r.hit.worktreeId) ?? "a worktree"}</span>
              {r.hit.archived && <span className="row-dim">archived</span>}
              <span className="chats-said row-dim">
                {r.hit.role === "user" ? "you" : "the agent"}
                {r.hit.ts > 0 ? ` · ${ago(r.hit.ts)}` : ""}
              </span>
            </span>
            <span className="chats-text">{markHits(r.hit.text, charsOf(r.hit.match), 0)}</span>
          </>
        )
      }
    />
  );
}
