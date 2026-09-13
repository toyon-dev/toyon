import type { SearchHit } from "@toyon/shared";
import { useCallback } from "react";
import { fileItems, openFile } from "../../state/actions/file.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { useLocal } from "../../state/selectors.ts";
import { worktreeById } from "../../state/store.ts";
import { ListPicker } from "../../ui/ListPicker.tsx";
import { wtDir } from "../util.ts";

const NONE: SearchHit[] = [];
/** short queries would match everything */
const MIN = 2;

/** ⌘⇧F: content search across the active worktree (git grep in the daemon, debounced) */
export function SearchPalette({ worktreeId }: { worktreeId: string }) {
  const dispatch = useDispatch();
  const sock = useSock();
  const results = useLocal(worktreeId).search;
  const leftOpen = useStore((s) => s.leftOpen);
  // a hit is a file: open in an editor or reveal it, as the changes panel's rows offer
  const dir = useStore((s) => {
    const w = worktreeById(s, worktreeId)?.worktree;
    return w ? wtDir(w) : null;
  });
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
      rowClass={() => "search-hit"}
      rowTitle={(h) => `${h.path}:${h.line}`}
      onPick={(hit) => {
        // a hit is a line in the file, as a ⌘P jump is a file: neither is a question about a diff
        openFile({ sock, dispatch }, { worktreeId, path: hit.path, view: "file", line: { n: hit.line } });
        if (!leftOpen) dispatch({ a: "toggle-left" });
        dispatch({ a: "close" });
      }}
      onBack={() => dispatch({ a: "close" })}
      rowMenu={(h) => (dir ? fileItems({ id: worktreeId, dir }, h.path, {}, { sock, dispatch }) : [])}
      placeholder="search in files…"
      keys={{ pick: "opens the file", back: "closes" }}
      empty={(q) => (q.trim().length < MIN ? "type at least two characters" : isStale(q) ? "searching…" : "no matches")}
      footer={(q, rows) =>
        results?.truncated && !isStale(q) && rows.length > 0 ? (
          <div className="empty">showing the first {rows.length}; narrow the search</div>
        ) : null
      }
      row={(h) => (
        <>
          <span className="search-loc">
            {h.path}:{h.line}
          </span>
          <span className="search-text">{h.text}</span>
        </>
      )}
    />
  );
}
