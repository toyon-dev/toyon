import { projectNameError } from "@toyon/shared";
import { useCallback } from "react";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import type { NewProjectState } from "../../state/store.ts";
import { ListPicker } from "../../ui/ListPicker.tsx";
import { PaletteRow } from "./PaletteRow.tsx";
import { destination, type FolderRow, folderName, folderRows, looksLikePath } from "./projectPicker.ts";

/** Where a new project goes, found by walking to the folder rather than typing its path, over the
 * new-project project it fills in. It opens at the folder the project already had. A click opens a folder,
 * the first row puts the project in the folder being shown, and backing out leaves the project as it
 * was. The field is the same path completion the project picker has, for someone who would rather
 * type. */
export function FolderPicker({ project }: { project: NewProjectState }) {
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

  const name = projectNameError(project.name) ? null : project.name.trim();
  const listing = (path: string) => `${path.replace(/\/+$/, "")}/`;

  return (
    <ListPicker<FolderRow>
      initialQuery={listing(project.parent)}
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
        if (r.kind !== "here") return;
        // choosing a location is choosing to make a folder there, even after an empty one was picked
        dispatch({
          a: "new-project-set",
          v: { mode: project.mode === "init" ? "create" : project.mode, parent: r.path },
        });
        dispatch({ a: "close" });
      }}
      onBack={() => dispatch({ a: "close" })}
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
