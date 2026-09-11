import { routeKey } from "@toyon/shared";
import { useCallback } from "react";
import { previewBus } from "../../app/previewBus.ts";
import { visitItems } from "../../state/actions/route.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { ListPicker } from "../../ui/ListPicker.tsx";
import { PaletteRow } from "../palettes/PaletteRow.tsx";
import { completionFor, pathOf, type Row, rowsFor } from "./routePicker.ts";

/** module constants, so a repo with no visits yet answers the selector with the same array */
const NONE: string[] = [];
const NO_ROWS: Row[] = [];

/** The route bar's list: the pages this project's previews are used on, most used first. It opens
 * over the address field the way the project switcher opens over its pill, holding the address
 * selected so typing replaces it, and a typed path that is not already a row leads as its own. */
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
  const frequent = useStore((s) => s.visits[repoId] ?? NONE);
  const current = pathOf(url);
  const here = url ? routeKey(url) : null;
  const filter = useCallback(
    (_items: Row[], q: string) => rowsFor({ query: q, current, here, frequent }),
    [current, here, frequent],
  );
  const close = () => dispatch({ a: "close" });
  return (
    <ListPicker<Row>
      anchored
      items={NO_ROWS}
      filter={filter}
      initialQuery={current}
      selectOnMount
      groupOf={(r) => r.kind}
      keyOf={(r) => `${r.kind}:${r.path}`}
      rowClass={() => "picker-row"}
      // the untouched address is what is on screen, not the start of a path, so it completes to nothing
      completionOf={(r, q) => (r.kind === "go" || q === current ? null : completionFor(r.path, q))}
      onPick={(r) => {
        previewBus.post(worktreeId, { type: "navigate", path: r.path });
        close();
      }}
      onBack={close}
      rowMenu={(r) => (r.kind === "frequent" ? visitItems(repoId, r.path, { sock }) : [])}
      placeholder="type a path"
      keys={{ complete: "completes the path", pick: "goes there", back: "closes" }}
      empty="no other pages yet; type a path"
      row={(r) => <PaletteRow label={r.path} hint={r.kind === "go" ? "go" : undefined} />}
    />
  );
}
