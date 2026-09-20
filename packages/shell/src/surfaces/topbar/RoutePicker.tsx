import { type PageEntry, routeKey, templateText } from "@toyon/shared";
import { type ReactNode, useCallback, useMemo } from "react";
import { previewBus } from "../../app/previewBus.ts";
import type { Deps } from "../../state/actions/deps.ts";
import { fileItems } from "../../state/actions/file.ts";
import { visitItems } from "../../state/actions/route.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { wantsLinks } from "../../state/links.ts";
import { useLocalField } from "../../state/selectors.ts";
import { worktreeById } from "../../state/store.ts";
import { useOnChange } from "../../ui/hooks.ts";
import { ListPicker } from "../../ui/ListPicker.tsx";
import { type MenuEntry, SEP, tidy } from "../../ui/menu.ts";
import { completionOf, fillTemplate, type PageModel, pageModel, pathOf, type Row, rowsFor } from "./routePicker.ts";

/** module constants, so a repo with no visits yet answers the selector with the same array */
const NONE: PageEntry[] = [];
const NO_ROWS: Row[] = [];

/** What a list of pages is made from: the repo's history and the worktree's pages, and for an app no
 * scan could read, the links its pages show, gathered from the page on screen as the list opens.
 * The address bar's list and ⌘P's `/` both read it. */
export function usePageModel(worktreeId: string, repoId: string | null): PageModel {
  const history = useStore((s) => (repoId ? s.visits[repoId] : undefined) ?? NONE);
  const pages = useLocalField(worktreeId, "pages");
  const links = useLocalField(worktreeId, "links");
  useOnChange([worktreeId], () => {
    if (wantsLinks(pages)) previewBus.post(worktreeId, { type: "links" });
  });
  return useMemo(() => pageModel(history, pages, links), [history, pages, links]);
}

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
export function RouteRow({ row }: { row: Row }) {
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

/** a page row's hover: the file that declares it, when one does */
export const pageRowTitle = (row: Row) => (row.kind === "page" && row.file ? row.file : row.path);

/** a template is not a place: enter puts its start in the field and shows the rest to fill in */
export const narrowPage = (row: Row, q: string) =>
  row.kind === "page" && row.template ? fillTemplate(row.path, q) : null;

/** what enter does on a page row */
export const goVerb = (row: Row) => (row.kind === "page" && row.template ? "fills in the parameter" : "goes there");

/** a page names its file, which offers the file's own list, and a visited one can come off the history */
export function pageMenu(
  row: Row,
  at: { worktreeId: string; repoId: string; dir: string | null },
  deps: Deps,
): MenuEntry[] {
  if (row.kind !== "page") return [];
  return tidy([
    ...(row.file && at.dir ? fileItems({ id: at.worktreeId, dir: at.dir }, row.file, {}, deps) : []),
    SEP,
    ...(row.visited ? visitItems(at.repoId, row.path, deps) : []),
  ]);
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
  const dir = useStore((s) => {
    const w = worktreeById(s, worktreeId);
    return w ? w.worktree.path : null;
  });
  const model = usePageModel(worktreeId, repoId);
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
      // the panel is the field's own box: it takes its width and lies exactly on it
      anchored={{ matchWidth: 0 }}
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
      rowTitle={pageRowTitle}
      completionOf={(r, q) => (untouched(q) ? null : completionOf(r, q))}
      narrowTo={narrowPage}
      onPick={(r) => {
        previewBus.post(worktreeId, { type: "navigate", path: r.path });
        close();
      }}
      onBack={close}
      rowMenu={(r) => pageMenu(r, { worktreeId, repoId, dir }, { sock, dispatch })}
      placeholder="type a path"
      keys={(active) => ({
        complete: "completes the path",
        pick: active ? goVerb(active) : "reloads",
        back: "closes",
      })}
      empty="no pages yet; type a path"
      row={(r) => <RouteRow row={r} />}
    />
  );
}
