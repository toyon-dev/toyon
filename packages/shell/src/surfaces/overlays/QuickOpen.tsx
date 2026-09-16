import { type GitFileStatus, routeKey } from "@toyon/shared";
import { useCallback } from "react";
import { previewBus } from "../../app/previewBus.ts";
import { fileItems, listFiles, openFile } from "../../state/actions/file.ts";
import { useDispatch, useSock, useStore, useStoreInstance } from "../../state/context.tsx";
import { useLocal } from "../../state/selectors.ts";
import { routeTarget, worktreeById } from "../../state/store.ts";
import { markHits } from "../../ui/highlight.tsx";
import { useOnChange } from "../../ui/hooks.ts";
import { ListPicker } from "../../ui/ListPicker.tsx";
import { LineCounts } from "../changes/GitFileRow.tsx";
import { goVerb, narrowPage, pageMenu, pageRowTitle, RouteRow, usePageModel } from "../topbar/RoutePicker.tsx";
import { type Row as PageRow, completionOf as pageCompletion, rowsFor } from "../topbar/routePicker.ts";
import { wtDir, xyClass, xyLetter } from "../util.ts";
import { commandRow } from "./CommandPalette.tsx";
import { type Command, filterCommands, useCommands } from "./commands.ts";
import { matchPositions, rankFiles, splitPath } from "./quickOpen.ts";

type Row =
  | { kind: "file"; path: string; status?: GitFileStatus }
  | { kind: "cmd"; c: Command }
  | { kind: "page"; page: PageRow };
const NONE: Row[] = [];
const EMPTY_PATHS: string[] = [];
const EMPTY_STATUS: GitFileStatus[] = [];

/** ⌘P: fuzzy file jump. A leading `>` switches the same box to the command palette (editor
 * convention), and a leading `/` to the preview's pages, the address bar's list: a worktree's file
 * paths never start with a slash and a page's always does. */
export function QuickOpen({ worktreeId }: { worktreeId: string }) {
  const dispatch = useDispatch();
  const sock = useSock();
  const store = useStoreInstance();
  // the list in hand is shown at once; a fresh one is asked for if the files can have moved
  useOnChange([worktreeId, sock], () => listFiles(worktreeId, store.getState(), { sock, dispatch }));
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
  const repoId = useStore((s) => worktreeById(s, worktreeId)?.repoId ?? null);
  const live = useStore((s) => routeTarget(s)?.worktreeId === worktreeId);
  const pages = usePageModel(worktreeId, repoId);
  const here = local.page.url ? routeKey(local.page.url) : null;

  // changed files lead an empty query (same order as the changes panel); once typing, it's fuzzy
  // order with a small nudge for changed files
  const filter = useCallback(
    (_items: Row[], q: string): Row[] => {
      if (q.startsWith(">")) return filterCommands(commands, q.slice(1)).map((c) => ({ kind: "cmd", c }));
      // a bare slash is the address bar's untouched list: the pages you would expect to go to
      if (q.startsWith("/")) {
        return live ? rowsFor(pages, { query: q, current: "/", here }).map((page) => ({ kind: "page", page })) : NONE;
      }
      return rankFiles(paths, status, q).rows.map((r) => ({ kind: "file", path: r.path, status: r.status }));
    },
    [commands, paths, status, live, pages, here],
  );

  return (
    <ListPicker
      items={NONE}
      filter={filter}
      keyOf={(r) =>
        r.kind === "cmd" ? `c:${r.c.id}` : r.kind === "page" ? `p:${r.page.kind}:${r.page.path}` : `f:${r.path}`
      }
      rowClass={(r) => (r.kind === "file" ? "qo-file" : "picker-row")}
      rowTitle={(r) => (r.kind === "page" ? pageRowTitle(r.page) : undefined)}
      completionOf={(r, q) => (r.kind === "page" ? pageCompletion(r.page, q) : null)}
      narrowTo={(r, q) => (r.kind === "page" ? narrowPage(r.page, q) : null)}
      onPick={(r, q) => {
        if (r.kind === "cmd") {
          if (r.c.sub) dispatch({ a: "palette-return", v: { mode: "quick-open", q } });
          else dispatch({ a: "close" });
          r.c.run();
        } else if (r.kind === "page") {
          previewBus.post(worktreeId, { type: "navigate", path: r.page.path });
          dispatch({ a: "close" });
        } else {
          // a jump is to the file, which may not have changed at all; its diff is a menu item away,
          // and the changes list is where diffs are read
          openFile({ sock, dispatch }, { worktreeId, path: r.path, view: "file" });
          dispatch({ a: "close" });
        }
      }}
      onBack={() => dispatch({ a: "close" })}
      rowMenu={(r) =>
        r.kind === "file" && dir
          ? fileItems({ id: worktreeId, dir }, r.path, {}, { sock, dispatch })
          : r.kind === "page" && repoId
            ? pageMenu(r.page, { worktreeId, repoId, dir }, { sock, dispatch })
            : []
      }
      placeholder="jump to file · type > for commands, / for pages"
      keys={(active, q) =>
        q.startsWith("/")
          ? {
              complete: "completes the path",
              pick: active?.kind === "page" ? goVerb(active.page) : undefined,
              back: "closes",
            }
          : { pick: "opens", back: "closes" }
      }
      initialQuery={initialQuery}
      empty={(q) =>
        q.startsWith(">")
          ? "no matching command"
          : q.startsWith("/")
            ? live
              ? "no pages yet; type a path"
              : "no preview running"
            : "no matches"
      }
      row={(r, _active, q) =>
        r.kind === "cmd" ? (
          commandRow(r.c, q.slice(1))
        ) : r.kind === "page" ? (
          <RouteRow row={r.page} />
        ) : (
          fileRow(r.path, r.status, q)
        )
      }
    />
  );
}

/** one file row: status letter, highlighted basename, dimmed directory, line counts. Exported so
 * the composer's `@` menu draws the same row as ⌘P rather than a lookalike; a folder there takes
 * the same row with its trailing slash, the way it is inserted. */
export function fileRow(path: string, status: GitFileStatus | undefined, q: string, folder = false) {
  const [name, dir] = splitPath(path);
  const hits = q.trim() ? matchPositions(path, q.trim()) : null;
  return (
    <>
      <span className={`xy ${status ? xyClass(status.xy) : ""}`}>{status ? xyLetter(status.xy) : ""}</span>
      <span className="name">
        {markHits(name, hits, dir.length)}
        {folder && "/"}
      </span>
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
