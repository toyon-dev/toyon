import type { SearchHit } from "@orchardist/shared";
import { useCallback } from "react";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { useLocal } from "../../state/selectors.ts";
import { ListPicker } from "../../ui/ListPicker.tsx";

const NONE: SearchHit[] = [];
/** short queries would match everything */
const MIN = 2;

/** ⌘⇧F: content search across the active worktree (git grep in the daemon, debounced) */
export function SearchPalette({ worktreeId }: { worktreeId: string }) {
  const dispatch = useDispatch();
  const sock = useSock();
  const results = useLocal(worktreeId).search;
  const leftOpen = useStore((s) => s.leftOpen);
  // stale = the daemon hasn't answered this query yet; keep showing the previous hits meanwhile
  const filter = useCallback((hits: SearchHit[], q: string) => (q.trim().length >= MIN ? hits : NONE), []);
  const onQuery = useCallback(
    (q: string) => {
      const t = q.trim();
      if (t.length >= MIN) sock?.send({ t: "search", worktreeId, query: t });
    },
    [sock, worktreeId],
  );
  const isStale = (q: string) => !results || results.query.trim() !== q.trim();
  return (
    <ListPicker
      items={results?.hits ?? NONE}
      filter={filter}
      onQuery={onQuery}
      keyOf={(h) => `${h.path}:${h.line}`}
      rowClass={() => "sr-item"}
      rowTitle={(h) => `${h.path}:${h.line}`}
      onPick={(hit) => {
        dispatch({ a: "goto-line", v: { worktreeId, path: hit.path, line: hit.line } });
        sock?.send({ t: "file-diff", worktreeId, path: hit.path });
        if (!leftOpen) dispatch({ a: "toggle-left" });
        dispatch({ a: "close" });
      }}
      onBack={() => dispatch({ a: "close" })}
      placeholder="search in files…"
      empty={(q) => (q.trim().length < MIN ? "type at least two characters" : isStale(q) ? "searching…" : "no matches")}
      footer={(q, rows) =>
        results?.truncated && !isStale(q) && rows.length > 0 ? (
          <div className="dock-empty">showing the first {rows.length} — narrow the search</div>
        ) : null
      }
      row={(h) => (
        <>
          <span className="sr-loc">
            {h.path}
            <span className="sr-line">:{h.line}</span>
          </span>
          <span className="sr-text">{h.text}</span>
        </>
      )}
    />
  );
}
