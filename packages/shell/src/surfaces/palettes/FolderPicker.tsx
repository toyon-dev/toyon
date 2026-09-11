import { projectNameError } from "@toyon/shared";
import { useCallback } from "react";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import type { NewProjectForm } from "../../state/store.ts";
import { ListPicker } from "../../ui/ListPicker.tsx";
import { PaletteRow } from "./PaletteRow.tsx";
import { destination, type FolderRow, folderName, folderRows, looksLikePath } from "./projectPicker.ts";

/** Where a new project goes, found by walking to the folder rather than typing its path. The form's
 * `change` opens it at the folder the form already had. A click opens a folder, the first row puts
 * the project in the folder being shown, and backing out returns to the form as it was. The field
 * is the same path completion the project picker has, for someone who would rather type. */
export function FolderPicker({ form }: { form: NewProjectForm }) {
  const dispatch = useDispatch();
  const sock = useSock();
  const paths = useStore((s) => s.paths);
  const home = useStore((s) => s.home);

  const onQuery = useCallback(
    (q: string) => {
      if (looksLikePath(q)) sock?.send({ t: "browse-path", path: q });
    },
    [sock],
  );

  const filter = useCallback(
    (_items: FolderRow[], q: string) =>
      folderRows({ query: q, entries: paths.entries, target: paths.target, answered: paths.query, home }),
    [paths, home],
  );

  const name = projectNameError(form.name) ? null : form.name.trim();
  const listing = (path: string) => `${path.replace(/\/+$/, "")}/`;

  return (
    <ListPicker<FolderRow>
      initialQuery={listing(form.parent)}
      // what the folder is being found for, the way the project picker's chip names the open project
      lead={<span className="picker-chip">{name ?? "new project"}</span>}
      items={[]}
      filter={filter}
      keyOf={(r) => (r.kind === "dir" ? `d:${r.entry.path}` : `${r.kind}:${r.path}`)}
      rowClass={() => "picker-row folder-row"}
      onQuery={onQuery}
      completionOf={(r) => (r.kind === "dir" ? listing(r.entry.path) : null)}
      narrowTo={(r) => (r.kind === "dir" ? listing(r.entry.path) : r.kind === "up" ? listing(r.path) : null)}
      onPick={(r) => {
        // choosing a location is choosing to make a folder there, even after an empty one was picked
        if (r.kind === "here") {
          dispatch({
            a: "open",
            overlay: { ...form, mode: form.mode === "init" ? "create" : form.mode, parent: r.path },
          });
        }
      }}
      // esc reaches the reducer as a close with back, which does the same
      onBack={() => dispatch({ a: "open", overlay: form })}
      placeholder="type a folder path"
      keys={(active) => ({
        complete: "completes the path",
        pick: active?.kind === "here" ? "chooses it" : active?.kind === "up" ? "goes up" : "opens it",
        back: "goes back",
      })}
      empty="no such folder"
      row={(r) =>
        r.kind === "here" ? (
          <PaletteRow
            label={`put ${name ?? "it"} in ${folderName(r.path, home)}`}
            // isolated, so the row's right-to-left truncation cuts the start without reordering the slashes
            hint={<bdi>{name ? destination(r.path, name) : r.path}</bdi>}
          />
        ) : r.kind === "up" ? (
          <PaletteRow label={`up to ${folderName(r.path, home)}`} hint={<bdi>{r.path}</bdi>} />
        ) : (
          <PaletteRow label={r.entry.name} />
        )
      }
    />
  );
}
