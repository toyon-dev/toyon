import { type PageEntry, routeKey } from "@toyon/shared";
import { useCallback, useMemo } from "react";
import { previewBus } from "../../app/previewBus.ts";
import { fileItems } from "../../state/actions/file.ts";
import { visitItems } from "../../state/actions/route.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { useLocalField } from "../../state/selectors.ts";
import { worktreeById } from "../../state/store.ts";
import { useOnChange } from "../../ui/hooks.ts";
import { ListPicker } from "../../ui/ListPicker.tsx";
import { PaletteRow } from "../palettes/PaletteRow.tsx";
import { wtDir } from "../util.ts";
import { changedRoutes, completionFor, pathOf, type Row, rowsFor } from "./routePicker.ts";

/** module constants, so a repo with no visits yet answers the selector with the same array */
const NONE: PageEntry[] = [];
const NO_ROWS: Row[] = [];

const isTemplate = (r: Row) => r.kind === "changed" && r.dynamic;

/** The route bar's list: the pages this branch changed, then the pages the project's previews are
 * used on, most used first. It opens over the address field the way the project switcher opens over
 * its pill, holding the address selected so typing replaces it, and a typed path that is not already
 * a row leads as its own. */
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
  const frequent = useMemo(() => history.map((p) => p.path), [history]);
  const routes = useLocalField(worktreeId, "routes");
  const git = useLocalField(worktreeId, "git");
  const dir = useStore((s) => {
    const w = worktreeById(s, worktreeId);
    return w ? wtDir(w.worktree) : null;
  });
  // the file layout is read each time the list opens, so a page the agent just added is on it; the
  // daemon keeps a scan for a few seconds, and git status keeps the changed set live meanwhile
  useOnChange([worktreeId], () => sock?.send({ t: "routes", worktreeId }));
  const changed = useMemo(() => changedRoutes(routes, git), [routes, git]);
  const current = pathOf(url);
  const here = url ? routeKey(url) : null;
  const filter = useCallback(
    (_items: Row[], q: string) => rowsFor({ query: q, current, here, frequent, changed }),
    [current, here, frequent, changed],
  );
  const close = () => dispatch({ a: "close" });
  return (
    <ListPicker<Row>
      anchored
      items={NO_ROWS}
      filter={filter}
      initialQuery={current}
      selectOnMount
      keyOf={(r) => `${r.kind}:${r.path}`}
      rowClass={() => "picker-row"}
      rowTitle={(r) => (r.kind === "changed" ? r.file : r.path)}
      // the untouched address is what is on screen, not the start of a path, so it completes to
      // nothing; nor does a template, whose parameter is filled in rather than completed
      completionOf={(r, q) => (r.kind === "go" || isTemplate(r) || q === current ? null : completionFor(r.path, q))}
      // a template is not a place: enter puts it in the field to be filled in
      narrowTo={(r) => (isTemplate(r) ? r.path : null)}
      onPick={(r) => {
        previewBus.post(worktreeId, { type: "navigate", path: r.path });
        close();
      }}
      onBack={close}
      // a visited page can come off the list, and a changed one names its file, which offers the file's own list
      rowMenu={(r) =>
        r.kind === "frequent"
          ? visitItems(repoId, r.path, { sock })
          : r.kind === "changed" && dir
            ? fileItems({ id: worktreeId, dir }, r.file, {}, { sock, dispatch })
            : []
      }
      placeholder="type a path"
      keys={(active) => ({
        complete: "completes the path",
        pick: active && isTemplate(active) ? "fills in the parameter" : "goes there",
        back: "closes",
      })}
      empty="no other pages yet; type a path"
      row={(r) => (
        <PaletteRow label={r.path} hint={r.kind === "go" ? "go" : r.kind === "changed" ? r.file : undefined} />
      )}
    />
  );
}
