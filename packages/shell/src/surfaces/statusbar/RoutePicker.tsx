import { type PageEntry, routeKey, templateText } from "@toyon/shared";
import { type ReactNode, useCallback, useMemo } from "react";
import { previewBus } from "../../app/previewBus.ts";
import { fileItems } from "../../state/actions/file.ts";
import { visitItems } from "../../state/actions/route.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { useLocalField } from "../../state/selectors.ts";
import { worktreeById } from "../../state/store.ts";
import { ListPicker } from "../../ui/ListPicker.tsx";
import { SEP, tidy } from "../../ui/menu.ts";
import { wtDir } from "../util.ts";
import { completionOf, fillTemplate, pageModel, pathOf, type Row, rowsFor } from "./routePicker.ts";

/** module constants, so a repo with no visits yet answers the selector with the same array */
const NONE: PageEntry[] = [];
const NO_ROWS: Row[] = [];

/** a row's path, a template's parameters drawn as the words to fill in */
function RoutePath({ row }: { row: Row }) {
  if (row.kind !== "page" || !row.template) return <span className="bar-route-path row-dim">{row.path}</span>;
  const { text, params } = templateText(row.path);
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [a, b] of params) {
    if (a > at) parts.push(text.slice(at, a));
    parts.push(
      <span key={a} className="bar-route-param">
        {text.slice(a, b)}
      </span>,
    );
    at = b;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <span className="bar-route-path row-dim">{parts}</span>;
}

/** a route row: the page's name, its path a tier quieter, then what changed since you last had it open */
function RouteRow({ row }: { row: Row }) {
  return (
    <>
      <span className="picker-label">{row.title}</span>
      <RoutePath row={row} />
      {row.kind === "go" ? (
        <span className="picker-hint row-dim">go</span>
      ) : row.badge ? (
        <span className={row.badge === "new" ? "badge-new" : "badge-changed"}>{row.badge}</span>
      ) : null}
    </>
  );
}

/** The route bar's list: what a person expects to see when they click the address. It opens in the
 * field's own box holding the address, selected, with nothing highlighted, so typing replaces the
 * address and enter on the untouched list reloads the page as a browser's would. The pages arrive
 * with the worktree's git status, so the rows are there on the first frame. */
export function RoutePicker({
  worktreeId,
  repoId,
  url,
}: {
  worktreeId: string;
  repoId: string;
  url: string | undefined;
}) {
  const dispatch = useDispatch();
  const sock = useSock();
  const history = useStore((s) => s.visits[repoId] ?? NONE);
  const pages = useLocalField(worktreeId, "pages");
  const dir = useStore((s) => {
    const w = worktreeById(s, worktreeId);
    return w ? wtDir(w.worktree) : null;
  });
  const model = useMemo(() => pageModel(history, pages), [history, pages]);
  const current = pathOf(url);
  const here = url ? routeKey(url) : null;
  const filter = useCallback(
    (_items: Row[], q: string) => rowsFor(model, { query: q, current, here }),
    [model, current, here],
  );
  // the address as it opened, or an empty field, has chosen nothing yet
  const untouched = useCallback((q: string) => q === current || q.trim() === "", [current]);
  const close = () => dispatch({ a: "close" });
  return (
    <ListPicker<Row>
      anchored
      items={NO_ROWS}
      filter={filter}
      initialQuery={current}
      selectOnMount
      idleWhen={untouched}
      onIdlePick={() => {
        previewBus.post(worktreeId, { type: "reload" });
        close();
      }}
      keyOf={(r) => `${r.kind}:${r.path}`}
      rowClass={() => "picker-row"}
      rowTitle={(r) => (r.kind === "page" && r.file ? r.file : r.path)}
      completionOf={(r, q) => (untouched(q) ? null : completionOf(r, q))}
      // a template is not a place: enter puts its start in the field and shows the rest to fill in
      narrowTo={(r, q) => (r.kind === "page" && r.template ? fillTemplate(r.path, q) : null)}
      onPick={(r) => {
        previewBus.post(worktreeId, { type: "navigate", path: r.path });
        close();
      }}
      onBack={close}
      // a page names its file, which offers the file's own list, and a visited one can come off the history
      rowMenu={(r) =>
        r.kind === "page"
          ? tidy([
              ...(r.file && dir ? fileItems({ id: worktreeId, dir }, r.file, {}, { sock, dispatch }) : []),
              SEP,
              ...(r.visited ? visitItems(repoId, r.path, { sock }) : []),
            ])
          : []
      }
      placeholder="type a path"
      keys={(active) => ({
        complete: "completes the path",
        pick: !active ? "reloads" : active.kind === "page" && active.template ? "fills in the parameter" : "goes there",
        back: "closes",
      })}
      empty="no pages yet; type a path"
      row={(r) => <RouteRow row={r} />}
    />
  );
}
