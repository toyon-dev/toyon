import { isLead } from "@toyon/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { archivedItems } from "../../state/actions/archive.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { useVisibleWorktrees } from "../../state/selectors.ts";
import { Button } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { markHits } from "../../ui/highlight.tsx";
import { ListPicker } from "../../ui/ListPicker.tsx";
import { ago } from "../util.ts";
import { archivedRow, type ChatScope, type ChatsRow, chatRows, liveRow, tooShort } from "./chats.ts";
import { PaletteRow } from "./PaletteRow.tsx";
import "./chats.css";

/** the indexes markHits lights, from each matched word's start and length */
const charsOf = (ranges: Array<[number, number]>) =>
  ranges.flatMap(([start, length]) => Array.from({ length }, (_, i) => start + i));

/** ⌘G: the project's chats and what they say. ⌘F finds in the chat on screen; this lists every
 * worktree's, the archived ones too, since "where did I ask for that" is mostly asked after the
 * branch has landed, and typing looks through all of them. A hit opens its chat with the message
 * marked and brought up. Removing a worktree archives it, so this is also where a remove is undone:
 * an archived row opens its page, and its menu restores it or deletes it for good. Looking through
 * the names alone is the switch for a title that half the chats happen to say. */
export function ChatsPicker({ repoId, scope: opened }: { repoId: string; scope: ChatScope }) {
  const dispatch = useDispatch();
  const sock = useSock();
  const clientId = useStore((s) => s.clientId);
  const frame = useStore((s) => s.frame);
  const results = useStore((s) => s.chats[repoId]);
  const live = useVisibleWorktrees();
  const archived = useStore((s) => s.archived[repoId]);
  const [scope, setScope] = useState(opened);
  const flip = useCallback(() => setScope((s) => (s === "all" ? "names" : "all")), []);
  // asked for on open rather than carried on hello: nobody reads the list until they open it
  useEffect(() => {
    sock?.send({ t: "list-archived", repoId });
  }, [sock, repoId]);
  // the lead has no chat yet, so it is never a place to look
  const chats = useMemo(
    () => [...live.filter((w) => !isLead(w.worktree)).map(liveRow), ...(archived ?? []).map(archivedRow)],
    [live, archived],
  );
  const byId = useMemo(() => new Map(chats.map((w) => [w.id, w])), [chats]);
  const items = useMemo(
    (): ChatsRow[] => [...chats, ...(results?.hits ?? []).map((hit) => ({ kind: "hit" as const, hit }))],
    [chats, results],
  );
  const filter = useCallback((rows: ChatsRow[], q: string) => chatRows(rows, q, scope), [scope]);
  // keyed on the scope as well, so turning the messages back on asks for what is already typed
  const onQuery = useCallback(
    (q: string) => {
      if (scope === "all" && !tooShort(q)) sock?.send({ t: "search-chats", repoId, query: q.trim() });
    },
    [sock, repoId, scope],
  );
  // stale = the daemon has not answered this query yet; the previous hits stay up meanwhile
  const isStale = (q: string) => !results || results.query !== q.trim();
  const searching = (q: string) => scope === "all" && !tooShort(q);
  return (
    <ListPicker
      items={items}
      filter={filter}
      onQuery={onQuery}
      onTab={flip}
      trailing={
        <Button tone="chrome" on={scope === "names"} aria-pressed={scope === "names"} onClick={flip}>
          names only
        </Button>
      }
      keyOf={(r) => (r.kind === "hit" ? `h:${r.hit.worktreeId}:${r.hit.seq}` : `w:${r.id}`)}
      rowClass={(r) =>
        r.kind === "hit" ? "chats-hit" : cx("picker-row", r.archived && !r.archived.restorable && "dim")
      }
      rowTitle={(r) => (r.kind === "hit" ? r.hit.text : (r.archived?.prompt ?? r.name))}
      // the daemon answers chat by chat, so a chat's hits already sit together; the head says
      // the chat's name once and the rows under it say only who and when. Drawn over a lone chat
      // too, or sixteen hits from one chat would name it nowhere.
      groupOf={(r) => (r.kind === "hit" ? `h:${r.hit.worktreeId}` : r.archived ? "archived" : "open")}
      groupHead={(group, n) => {
        if (!group.startsWith("h:")) return `${group} · ${n}`;
        const w = byId.get(group.slice(2));
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
        const gone = r.kind === "hit" ? r.hit.archived : !!r.archived;
        dispatch(gone ? { a: "open-archived", id } : { a: "activate", id });
        if (r.kind === "hit") dispatch({ a: "reveal", id, seq: r.hit.seq });
        dispatch({ a: "close" });
      }}
      onBack={() => dispatch({ a: "close" })}
      rowMenu={(r) =>
        r.kind === "chat" && r.archived ? archivedItems(r.archived, { clientId, frame }, { sock, dispatch }) : []
      }
      placeholder={scope === "names" ? "find a chat by name…" : "search in chats…"}
      keys={(active) => ({
        nav: "moves",
        tab: scope === "names" ? "searches messages too" : "searches names only",
        pick: active ? (active.kind === "hit" ? "opens the chat there" : "opens its chat") : undefined,
        back: "closes",
      })}
      empty={(q) =>
        !q.trim()
          ? archived
            ? "no chats yet"
            : "looking…"
          : !searching(q)
            ? "no chat is named that"
            : isStale(q)
              ? "searching…"
              : "no chat says that"
      }
      footer={(q, rows) => {
        const hits = rows.filter((r) => r.kind === "hit").length;
        return results?.truncated && !isStale(q) && hits > 0 ? (
          <div className="empty">showing the first {hits}; narrow the search</div>
        ) : null;
      }}
      row={(r) =>
        r.kind === "chat" ? (
          <PaletteRow label={r.name} hint={r.hint} />
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
