import { isOwned, type RepoInfo } from "@toyon/shared";
import { useCallback } from "react";
import { importItems, projectItems } from "../../state/actions/project.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import type { ProjectsOverlay } from "../../state/store.ts";
import { IconButton } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { Icon } from "../../ui/Icon.tsx";
import { ListPicker } from "../../ui/ListPicker.tsx";
import { isBusy } from "../util.ts";
import { PaletteRow } from "./PaletteRow.tsx";
import { defaultParent, looksLikePath, type Row, rowsFor } from "./projectPicker.ts";

/** ⌘O / the top-left pill: switch the shell to another registered repo, type a path to open one,
 * or make one that is not there yet. The daemon keeps every project's procs running; switching only
 * changes what is on screen. Typing a path completes against the filesystem: repos are openable,
 * plain folders are drilled into (enter or tab), so a nested checkout is reachable without typing
 * it out, and a name or a git URL matching nothing becomes an offer to create or clone.
 *
 * Three forms, one component. A click on the pill drops it out of the pill (`pill`) and takes the
 * bar over the way a browser's address bar does: the open project becomes a chip in the field, the
 * caret sits after it, and the rows are the projects you could switch to. A key or the palette opens
 * the same switcher over the preview (`center`), where the eyes are when nothing was clicked; the
 * pill sits at the far edge of the screen. `disk` is the centered form the field's folder button
 * opens, which starts in the home directory: more room for walking the filesystem, where the
 * anchored one would run out of screen. `embedded` is the dropdown hanging off ⌘K's repo chip,
 * inside an overlay that is already open and has to survive the switch. */
export function ProjectPicker({
  form = "pill",
  embedded = false,
  onDone,
}: {
  form?: ProjectsOverlay["form"];
  /** mounted inside another overlay (⌘K's repo chip) rather than owning the screen: closing is the
   * host's to define, since dispatching `close` here would take the host down with it */
  embedded?: boolean;
  onDone?: () => void;
}) {
  const dispatch = useDispatch();
  const sock = useSock();
  const repos = useStore((s) => s.repos);
  const current = useStore((s) => s.activeRepoId);
  const rows = useStore((s) => s.rows);
  const paths = useStore((s) => s.paths);
  const home = useStore((s) => s.home);
  const pending = useStore((s) => s.pending);

  // debounced by the picker; only path-shaped queries reach the daemon
  const onQuery = useCallback(
    (q: string) => {
      if (looksLikePath(q)) sock?.send({ t: "browse-path", path: q });
    },
    [sock],
  );

  // every row is derived from the query, so the item list is empty and this builds it
  const filter = useCallback(
    (_items: Row[], q: string) =>
      rowsFor({
        query: q,
        repos,
        activeRepoId: current,
        pending,
        // the daemon already matched these against the path; re-filtering here would only fight the
        // debounce and blank the list between keystrokes. Repos lead: they are what you came for.
        entries: [...paths.entries].sort((a, b) => Number(b.isRepo) - Number(a.isRepo)),
        target: paths.target,
        answered: paths.query,
      }),
    [repos, current, paths, pending],
  );

  const hintFor = (r: RepoInfo) => {
    const here = rows.filter((w) => w.repoId === r.id);
    const mine = here.filter(isOwned).filter((w) => w.worktree.kind !== "spare");
    const working = mine.filter(isBusy).length;
    const n = mine.length - 1; // main is not a task
    // "where's my stuff" is asked here, before the rail is on screen: a project with worktrees
    // toyon did not make should say so at the point you are choosing it
    const found = here.length - here.filter(isOwned).length;
    const parts = [
      n > 0 ? `${n} worktree${n === 1 ? "" : "s"}` : null,
      working > 0 ? `${working} working` : null,
      found > 0 ? `${found} discovered` : null,
    ];
    return parts.filter(Boolean).join(" · ") || undefined;
  };

  /** picked something, or backed out: the embedded picker hands both to its host */
  const finish = () => (onDone ? onDone() : dispatch({ a: "close" }));
  const goBack = () => (onDone ? onDone() : dispatch({ a: "close", back: true }));

  const open = (path: string) => {
    dispatch({ a: "open-repo" });
    sock?.send({ t: "register-repo", path });
  };

  /** a typed path already named its destination, so there is nothing left to ask about */
  const createAt = (parent: string, name: string) => {
    dispatch({ a: "open-repo" });
    sock?.send({ t: "create-repo", mode: "create", parent, name });
  };

  /** the form, for the rows where something would otherwise be guessed */
  const ask = (mode: "create" | "clone", name: string, url?: string) =>
    dispatch({
      a: "open",
      overlay: {
        kind: "new-project",
        mode,
        name,
        // a bare name says nothing about location: offer wherever the other projects already live
        parent: defaultParent(repos, current, home),
        ...(url ? { url } : {}),
      },
    });

  return (
    <ListPicker<Row>
      anchored={form === "pill"}
      initialQuery={form === "disk" ? "~/" : ""}
      // the chip says what you are switching away from, which is true of either switcher: the disk
      // form is a path browser and nothing in it is scoped to the open project
      lead={
        form === "disk" ? undefined : (
          <span className="picker-chip">{repos.find((r) => r.id === current)?.name ?? "no project"}</span>
        )
      }
      trailing={
        form === "disk" || embedded ? undefined : (
          <IconButton
            icon="folder"
            label="Find a project on disk"
            onClick={() => dispatch({ a: "open", overlay: { kind: "projects", form: "disk" } })}
          />
        )
      }
      items={[]}
      filter={filter}
      keyOf={(r) =>
        r.kind === "repo"
          ? r.repo.id
          : r.kind === "dir"
            ? `d:${r.entry.path}`
            : r.kind === "open"
              ? `open:${r.path}`
              : r.kind === "pending"
                ? `p:${r.pending.id}`
                : r.kind === "clone"
                  ? `clone:${r.url}`
                  : r.kind === "new"
                    ? "new-project"
                    : `new:${r.parent ?? ""}/${r.name}`
      }
      rowClass={(r) => cx("picker-row", r.kind === "new" && "new-project-row")}
      onQuery={onQuery}
      // a folder completes to itself with a trailing slash, so tab keeps walking down the tree
      completionOf={(r) => (r.kind === "dir" ? (r.entry.isRepo ? r.entry.path : `${r.entry.path}/`) : null)}
      // a plain folder is a step on the way, not a project: descend and keep the picker up
      narrowTo={(r) => (r.kind === "dir" && !r.entry.isRepo ? `${r.entry.path}/` : null)}
      onPick={(r) => {
        // `ask` opens the form, which *replaces* this overlay: closing after it would close the
        // form too, so those branches return rather than falling through to the close below
        if (r.kind === "clone") return ask("clone", r.name, r.url);
        if (r.kind === "create" && !r.parent) return ask("create", r.name);
        if (r.kind === "new") return ask("create", "");

        if (r.kind === "pending") dispatch({ a: "watch-import", id: r.pending.id });
        else if (r.kind === "repo") dispatch({ a: "activate-repo", id: r.repo.id });
        else if (r.kind === "open") open(r.path);
        else if (r.kind === "dir")
          open(r.entry.path); // only repo folders get here; narrowTo takes the rest
        else if (r.parent) createAt(r.parent, r.name);
        finish();
      }}
      onBack={goBack}
      // a project row is a project: its setup and its forget are a right-click away, as they are
      // in the palette; a clone still running can be stopped from its row
      rowMenu={(r) =>
        r.kind === "repo"
          ? projectItems(r.repo, current, { sock, dispatch })
          : r.kind === "pending"
            ? importItems(r.pending, { sock, dispatch })
            : []
      }
      placeholder={repos.length > 1 ? "switch project, or type a name or path" : "type a name or a path to start"}
      keys={(active) => ({
        complete: "completes the path",
        pick:
          active?.kind === "dir" && !active.entry.isRepo
            ? "descends"
            : active?.kind === "pending"
              ? "watches it"
              : active?.kind === "create"
                ? active.parent
                  ? "creates it"
                  : "names it"
                : active?.kind === "clone"
                  ? "clones it"
                  : active?.kind === "new"
                    ? "starts one"
                    : "opens",
        back: "closes",
      })}
      // an empty query always has the "new project" row, so there is always something typed here
      empty="nothing here; keep typing a path (~/… or /…)"
      row={(r) =>
        r.kind === "repo" ? (
          <PaletteRow label={r.repo.name} hint={hintFor(r.repo)} />
        ) : r.kind === "pending" ? (
          <PaletteRow label={r.pending.name} hint={r.pending.error ? "import failed" : "importing…"} />
        ) : r.kind === "dir" ? (
          <PaletteRow label={r.entry.name} hint={r.entry.isRepo ? "git repo" : undefined} />
        ) : r.kind === "open" ? (
          <PaletteRow label={`open ${r.path}`} hint="register with this daemon" />
        ) : r.kind === "clone" ? (
          <PaletteRow label={`clone ${r.name}`} hint={hostOf(r.url)} />
        ) : r.kind === "new" ? (
          <PaletteRow
            label={
              <>
                <Icon name="plus" className="icon-inline" />
                new project
              </>
            }
          />
        ) : (
          <PaletteRow label={`create ${r.name}`} hint={r.parent ? `in ${r.parent}` : "new project"} />
        )
      }
    />
  );
}

/** "github.com" out of a URL, for the hint on a clone row. Best effort: a hint is not worth a throw */
function hostOf(url: string): string {
  const m = url.match(/^[a-z+]+:\/\/(?:[^@/]*@)?([^/:]+)/i) ?? url.match(/^[^@]+@([^:]+):/);
  return m?.[1] ?? "git remote";
}
