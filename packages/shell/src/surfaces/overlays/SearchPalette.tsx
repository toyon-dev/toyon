import type { SearchHit } from "@toyon/shared";
import { useCallback, useEffect } from "react";
import { fileItems, openFile } from "../../state/actions/file.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { useLocal } from "../../state/selectors.ts";
import { worktreeById } from "../../state/store.ts";
import { markHits } from "../../ui/highlight.tsx";
import { ListPicker } from "../../ui/ListPicker.tsx";

const NONE: SearchHit[] = [];
/** short queries would match everything */
const MIN = 2;

/** every character of the line the query matched, as the daemon matched it: a fixed string,
 * case-insensitive, and every occurrence on the line. Null when lowercasing moved the columns
 * (a dotted capital I lowers to two code units), since the marks would then land beside the
 * match rather than on it. */
export function searchHits(text: string, query: string): number[] | null {
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  if (!q || t.length !== text.length) return null;
  const out: number[] = [];
  for (let at = t.indexOf(q); at !== -1; at = t.indexOf(q, at + q.length)) {
    for (let i = 0; i < q.length; i++) out.push(at + i);
  }
  return out.length ? out : null;
}

/** ⌘⇧F: content search across the active worktree (git grep in the daemon, debounced) */
export function SearchPalette({ worktreeId }: { worktreeId: string }) {
  const dispatch = useDispatch();
  const sock = useSock();
  const results = useLocal(worktreeId).search;
  const changesOpen = useStore((s) => s.layout.changes);
  // a hit is a file: open in an editor or reveal it, as the changes panel's rows offer
  const dir = useStore((s) => {
    const w = worktreeById(s, worktreeId)?.worktree;
    return w ? w.path : null;
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
  // the palette closing mid-search: the daemon would finish scanning the repo for a page nobody
  // sees. On a socket swap the stop goes to the old socket, which is also right.
  useEffect(() => () => sock?.send({ t: "search-stop" }), [sock]);
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
        if (!changesOpen) dispatch({ a: "toggle-changes" });
        dispatch({ a: "close" });
      }}
      onBack={() => dispatch({ a: "close" })}
      rowMenu={(h) => (dir ? fileItems({ id: worktreeId, dir }, h.path, {}, { sock, dispatch }) : [])}
      placeholder="search in files…"
      empty={(q) =>
        q.trim().length < MIN ? (
          "type at least two characters"
        ) : isStale(q) ? (
          <span className="live-text">searching</span>
        ) : (
          "no matches"
        )
      }
      footer={(q, rows) =>
        results?.truncated && !isStale(q) && rows.length > 0 ? (
          <div className="empty">not every match is shown; narrow the search</div>
        ) : null
      }
      row={(h, _active, q) => (
        <>
          <span className="search-loc">
            {h.path}:{h.line}
          </span>
          <span className="search-text">{markHits(h.text, searchHits(h.text, q), 0)}</span>
        </>
      )}
    />
  );
}
