import type { GitFileStatus } from "@toyon/shared";
import { useCallback } from "react";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { useLocal } from "../../state/selectors.ts";
import { ListPicker } from "../../ui/ListPicker.tsx";
import { LineCounts } from "../changes/GitFileRow.tsx";
import { xyClass, xyLetter } from "../util.ts";
import { commandRow } from "./CommandPalette.tsx";
import { type Command, filterCommands, useCommands } from "./commands.ts";
import { markHits } from "./highlight.tsx";
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
      rowClass={(r) => (r.kind === "cmd" ? "cmd-item" : "qo-file")}
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
      placeholder="jump to file · type > for commands"
      keys={{ pick: "opens", back: "closes" }}
      initialQuery={initialQuery}
      empty={(q) => (q.startsWith(">") ? "no matching command" : "no matches")}
      row={(r, _active, q) => {
        if (r.kind === "cmd") return commandRow(r.c, q.slice(1));
        const [name, dir] = splitPath(r.path);
        const hits = q.trim() ? matchPositions(r.path, q.trim()) : null;
        return (
          <>
            <span className={`xy ${r.status ? xyClass(r.status.xy) : ""}`}>
              {r.status ? xyLetter(r.status.xy) : ""}
            </span>
            <span className="name">{markHits(name, hits, dir.length)}</span>
            <span className="dir">
              {dir && (
                <>
                  {"\u200e"}
                  {markHits(dir, hits, 0)}
                  {"\u200e"}
                </>
              )}
            </span>
            {r.status && <LineCounts f={r.status} />}
          </>
        );
      }}
    />
  );
}
