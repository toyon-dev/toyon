import { type ArchivedWorktree, type ChatHit, isLead, type OwnedWorktree, queryTerms } from "@toyon/shared";
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
/** measured as the daemon measures it: what is searched for, not the quotes around it */
const tooShort = (q: string) => queryTerms(q).join(" ").length < MIN;

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

/** the indexes markHits lights, from each matched word's start and length */
const charsOf = (ranges: Array<[number, number]>) =>
  ranges.flatMap(([start, length]) => Array.from({ length }, (_, i) => start + i));

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
  // the lead has no chat yet, so it is never a place to look
  const worktrees = useMemo(
    () => [...live.filter((w) => !isLead(w.worktree)).map(liveRow), ...archived.map(archivedRow)],
    [live, archived],
  );
  const byId = useMemo(() => new Map(worktrees.map((w) => [w.id, w])), [worktrees]);
  const items = useMemo(
    (): ChatsRow[] => [...worktrees, ...(results?.hits ?? []).map((hit) => ({ kind: "hit" as const, hit }))],
    [worktrees, results],
  );
  // the hits are the daemon's answer, shown as they came; the worktrees are matched here, by the
  // daemon's rule: every term somewhere in the name or the branch, a quoted phrase whole
  const filter = useCallback((rows: ChatsRow[], q: string) => {
    if (tooShort(q)) return NONE;
    const terms = queryTerms(q);
    return rows.filter(
      (r) => r.kind === "hit" || terms.every((t) => r.fields.some((f) => f.toLowerCase().includes(t))),
    );
  }, []);
  const onQuery = useCallback(
    (q: string) => {
      if (!tooShort(q)) sock?.send({ t: "search-chats", repoId, query: q.trim() });
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
      // the daemon answers chat by chat, so a chat's hits already sit together; the head says
      // the chat's name once and the rows under it say only who and when. Drawn over a lone chat
      // too, or sixteen hits from one chat would name it nowhere.
      groupOf={(r) => (r.kind === "hit" ? r.hit.worktreeId : "named")}
      groupHead={(group, n) => {
        if (group === "named") return `by name · ${n}`;
        const w = byId.get(group);
        // one span: the head is a flex box, and bare text beside the archived mark would lose the
        // space between them
        return (
          <span>
            {w?.name ?? "a worktree"}
            {w?.archived && (
              <>
                {" "}
                <span className="row-dim">archived</span>
              </>
            )}
            {` · ${n}`}
          </span>
        );
      }}
      headAlone
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
      empty={(q) => (tooShort(q) ? "type at least two characters" : isStale(q) ? "searching…" : "no chat says that")}
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
            <span className="chats-text">{markHits(r.hit.text, charsOf(r.hit.match), 0)}</span>
            <span className="chats-said row-dim">
              {r.hit.role === "user" ? "you" : "the agent"}
              {r.hit.ts > 0 ? ` · ${ago(r.hit.ts)}` : ""}
            </span>
          </>
        )
      }
    />
  );
}
