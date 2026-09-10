import type { GitFileStatus } from "@toyon/shared";
import { useCallback } from "react";
import { fileItems } from "../../state/actions/file.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { useLocal } from "../../state/selectors.ts";
import { worktreeById } from "../../state/store.ts";
import { markHits } from "../../ui/highlight.tsx";
import { ListPicker } from "../../ui/ListPicker.tsx";
import { LineCounts } from "../changes/GitFileRow.tsx";
import { wtDir, xyClass, xyLetter } from "../util.ts";
import { commandRow } from "./CommandPalette.tsx";
import { type Command, filterCommands, useCommands } from "./commands.ts";
import { matchPositions, rankFiles, splitPath } from "./quickOpen.ts";

type Row = { kind: "file"; path: string; status?: GitFileStatus } | { kind: "cmd"; c: Command };
const NONE: Row[] = [];
const EMPTY_PATHS: string[] = [];
const EMPTY_STATUS: GitFileStatus[] = [];

/** ⌘P: fuzzy file jump; a leading `>` switches the same box to the command palette (editor convention) */
export function QuickOpen({ worktreeId }: { worktreeId: string }) {
  const dispatch = useDispatch();
  const sock = useSock();
  const local = useLocal(worktreeId);
  const paths = local.files ?? EMPTY_PATHS;
  const status = local.git?.files ?? EMPTY_STATUS;
  const commands = useCommands();
  const initialQuery = useStore((s) => (s.paletteReturn?.mode === "quick-open" ? s.paletteReturn.q : ""));
  // a file row is a file: open in an editor or reveal it, as the changes panel's rows offer
  const dir = useStore((s) => {
    const w = worktreeById(s, worktreeId)?.worktree;
    return w ? wtDir(w) : null;
  });

  // changed files lead an empty query (same order as the changes panel); once typing, it's fuzzy
  // order with a small nudge for changed files
  const filter = useCallback(
    (_items: Row[], q: string): Row[] =>
      q.startsWith(">")
        ? filterCommands(commands, q.slice(1)).map((c) => ({ kind: "cmd", c }))
        : rankFiles(paths, status, q).rows.map((r) => ({ kind: "file", path: r.path, status: r.status })),
    [commands, paths, status],
  );

  return (
    <ListPicker
      items={NONE}
      filter={filter}
      keyOf={(r) => (r.kind === "cmd" ? `c:${r.c.id}` : `f:${r.path}`)}
      rowClass={(r) => (r.kind === "cmd" ? "picker-row" : "qo-file")}
      onPick={(r, q) => {
        if (r.kind === "cmd") {
          if (r.c.sub) dispatch({ a: "palette-return", v: { mode: "quick-open", q } });
          else dispatch({ a: "close" });
          r.c.run();
        } else {
          sock?.send({ t: "file-diff", worktreeId, path: r.path });
          dispatch({ a: "close" });
        }
      }}
      onBack={() => dispatch({ a: "close" })}
      rowMenu={(r) =>
        r.kind === "file" && dir ? fileItems({ id: worktreeId, dir }, r.path, false, { sock, dispatch }) : []
      }
      placeholder="jump to file · type > for commands"
      keys={{ pick: "opens", back: "closes" }}
      initialQuery={initialQuery}
      empty={(q) => (q.startsWith(">") ? "no matching command" : "no matches")}
      row={(r, _active, q) => (r.kind === "cmd" ? commandRow(r.c, q.slice(1)) : fileRow(r.path, r.status, q))}
    />
  );
}

/** one file row: status letter, highlighted basename, dimmed directory, line counts. Exported so
 * the composer's `@` menu draws the same row as ⌘P rather than a lookalike. */
export function fileRow(path: string, status: GitFileStatus | undefined, q: string) {
  const [name, dir] = splitPath(path);
  const hits = q.trim() ? matchPositions(path, q.trim()) : null;
  return (
    <>
      <span className={`xy ${status ? xyClass(status.xy) : ""}`}>{status ? xyLetter(status.xy) : ""}</span>
      <span className="name">{markHits(name, hits, dir.length)}</span>
      <span className="dir row-dim">
        {dir && (
          <>
            {"\u200e"}
            {markHits(dir, hits, 0)}
            {"\u200e"}
          </>
        )}
      </span>
      {status && <LineCounts f={status} />}
    </>
  );
}
