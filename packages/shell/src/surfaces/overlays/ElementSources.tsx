import type { SearchHit } from "@toyon/shared";
import { useCallback } from "react";
import { fileItems, openFile } from "../../state/actions/file.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { worktreeById } from "../../state/store.ts";
import { ListPicker } from "../../ui/ListPicker.tsx";
import { wtDir } from "../util.ts";

/** A picked element with no recorded source that more than one line could have written: the
 * daemon's places for it, best first, to open the one it is. Rows read as search hits do. */
export function ElementSources({ worktreeId, hits }: { worktreeId: string; hits: SearchHit[] }) {
  const dispatch = useDispatch();
  const sock = useSock();
  const changesOpen = useStore((s) => s.changesOpen);
  const dir = useStore((s) => {
    const w = worktreeById(s, worktreeId)?.worktree;
    return w ? wtDir(w) : null;
  });
  const filter = useCallback((items: SearchHit[], q: string) => {
    const t = q.trim().toLowerCase();
    return t ? items.filter((h) => `${h.path}:${h.line} ${h.text}`.toLowerCase().includes(t)) : items;
  }, []);
  return (
    <ListPicker
      items={hits}
      filter={filter}
      keyOf={(h) => `${h.path}:${h.line}`}
      rowClass={() => "search-hit"}
      rowTitle={(h) => `${h.path}:${h.line}`}
      onPick={(hit) => {
        openFile({ sock, dispatch }, { worktreeId, path: hit.path, view: "file", line: { n: hit.line } });
        if (!changesOpen) dispatch({ a: "toggle-changes" });
        dispatch({ a: "close" });
      }}
      onBack={() => dispatch({ a: "close" })}
      rowMenu={(h) => (dir ? fileItems({ id: worktreeId, dir }, h.path, {}, { sock, dispatch }) : [])}
      placeholder="lines that could write this element"
      keys={{ pick: "opens the file", back: "closes" }}
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
