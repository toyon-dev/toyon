import { isOwned, projectOrder, type RepoInfo, type WorktreeStatus } from "@toyon/shared";
import { useCallback, useMemo } from "react";
import { machineLine } from "../../app/machineLine.ts";
import { machineItems } from "../../state/actions/machine.ts";
import { importItems, initProject, openProject, projectItems } from "../../state/actions/project.ts";
import {
  useDispatch,
  useMachine,
  useMachineStore,
  useMachines,
  useOtherMachines,
  useOtherMachinesRows,
  useSock,
  useStore,
} from "../../state/context.tsx";
import { edgeByOrigin } from "../../state/machines.ts";
import { newProjectState, type ProjectsOverlay } from "../../state/store.ts";
import { IconButton } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { Icon } from "../../ui/Icon.tsx";
import { ListPicker } from "../../ui/ListPicker.tsx";
import type { Anchored } from "../../ui/Overlay.tsx";
import { isBusy } from "../util.ts";
import { PaletteRow } from "./PaletteRow.tsx";
import { defaultParent, looksLikePath, type Row, rowsFor } from "./projectPicker.ts";

/** ⌘O / the top-left pill: switch the shell to another registered repo, type a path to open one,
 * or make one that is not there yet. Switching only changes what is on screen; the daemon keeps
 * every project's procs running. A typed path completes against the filesystem, a folder with no
 * git in it is offered as a project to start where it is, and a name or git URL matching nothing
 * becomes an offer to create or clone.
 *
 * Three forms, one component: `pill` drops out of the pill and takes the bar over like an address
 * bar; `center` is the same switcher over the preview, where the eyes are when a key opened it;
 * `disk` is the centred form the folder button opens, starting in the home directory, since the
 * anchored one runs out of screen when walking the filesystem. */
export function ProjectPicker({
  form,
  anchored,
}: {
  form: ProjectsOverlay["form"];
  /** how the pill form sits on its pill, where that differs from landing its lead on it: the
   * phone keeps the panel off the window's edge */
  anchored?: Anchored;
}) {
  const dispatch = useDispatch();
  const sock = useSock();
  const machines = useMachines();
  const here = useMachine();
  const hereName = machines.displayName(here.origin);
  const repos = useStore((s) => s.repos);
  // over the new-project view no project is the open one, so none is marked
  const current = useStore((s) => (s.newProject ? null : s.activeRepoId));
  const rows = useStore((s) => s.rows);
  const paths = useStore((s) => s.paths);
  const home = useStore((s) => s.home);
  const pending = useStore((s) => s.pending);
  // projects in the rail's order, the one last sent to first; the daemon lists them as registered
  const ordered = useMemo(() => projectOrder(repos, rows), [repos, rows]);
  // the other machines' projects, each list read off that machine's store and put in the same
  // order by that machine's rows; listed under the machine's name after everything about this one
  const otherMachines = useOtherMachines();
  const otherRows = useOtherMachinesRows();
  const others = useMemo(
    () =>
      otherMachines.map((m) => ({
        ...m,
        repos: projectOrder(m.repos, otherRows.find((o) => o.origin === m.origin)?.rows ?? []),
      })),
    [otherMachines, otherRows],
  );

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
        repos: ordered,
        pending,
        // the daemon already matched these against the path; re-filtering here would only fight the
        // debounce and blank the list between keystrokes. Repos lead: they are what you came for.
        entries: [...paths.entries].sort((a, b) => Number(b.isRepo) - Number(a.isRepo)),
        target: paths.target,
        answered: paths.query,
        home,
        others,
        current,
      }),
    [ordered, paths, pending, home, others, current],
  );

  const hintFor = (r: RepoInfo) => hintOf(rows, r);

  const finish = () => dispatch({ a: "close" });
  const goBack = () => dispatch({ a: "close", back: true });

  const deps = { sock, dispatch };
  const open = (path: string) => openProject(deps, { t: "register-repo", path });
  /** a typed path already named its destination, so there is nothing left to ask about */
  const createAt = (parent: string, name: string) =>
    openProject(deps, { t: "create-repo", mode: "create", parent, name });

  /** the new-project view, for the rows where something would otherwise be guessed */
  const ask = (mode: "create" | "clone", name: string, url?: string) =>
    dispatch({
      a: "new-project",
      v: newProjectState({
        mode,
        name,
        // a bare name says nothing about location: offer wherever the other projects already live
        parent: defaultParent(repos, current, home),
        ...(url ? { url } : {}),
      }),
    });

  /** the disk form: the folder button and the "open folder" row are one way in, said twice */
  const browse = () => dispatch({ a: "open", overlay: { kind: "projects", form: "disk" } });
  /** the add-machine card takes this overlay's place */
  const addMachine = () => dispatch({ a: "open", overlay: { kind: "devices" } });
  /** a project on another machine: that machine comes on screen, open on the project */
  const goElsewhere = (origin: string, repoId: string) => {
    const m = machines.get(origin);
    if (!m) return;
    m.store.dispatch({ a: "activate-repo", id: repoId });
    machines.activate(origin);
  };

  return (
    <ListPicker<Row>
      anchored={form === "pill" && (anchored ?? true)}
      initialQuery={form === "disk" ? "~/" : ""}
      // the chip says what you are switching away from, which is true of either switcher: the disk
      // form is a path browser and nothing in it is scoped to the open project
      lead={
        form === "disk" ? undefined : (
          <span className="picker-chip">{repos.find((r) => r.id === current)?.name ?? "no project"}</span>
        )
      }
      trailing={
        form === "disk" ? undefined : <IconButton icon="folder" label="Find a project on disk" onClick={browse} />
      }
      items={[]}
      filter={filter}
      // opens on the open project, as every picker opens on its current choice, so the edge and the
      // cursor start on one row: the first, since the standing list leads with it; with no open
      // project the clamp puts it on the first
      initialIndex={(rs) => rs.findIndex((r) => r.kind === "repo" && !r.machine && r.repo.id === current)}
      // each machine's projects under its name, this machine's first; with one machine listed no
      // head is drawn, since the rows then say what they are themselves. The key is the origin,
      // and the head drawn for it names the machine and, for another machine, what it needs of
      // you: the one place that says so short of switching to it
      groupOf={(r) =>
        r.kind === "machine" ? r.machine.origin : r.kind === "repo" && r.machine ? r.machine.origin : here.origin
      }
      groupHead={(origin) => (origin === here.origin ? hereName : <MachineHead origin={origin} />)}
      keyOf={(r) =>
        r.kind === "repo"
          ? r.machine
            ? `${r.machine.origin}:${r.repo.id}`
            : r.repo.id
          : r.kind === "dir"
            ? `d:${r.entry.path}`
            : r.kind === "open"
              ? `open:${r.path}`
              : r.kind === "init"
                ? `init:${r.path}`
                : r.kind === "pending"
                  ? `p:${r.pending.id}`
                  : r.kind === "clone"
                    ? `clone:${r.url}`
                    : r.kind === "new"
                      ? "new-project"
                      : r.kind === "disk"
                        ? "open-folder"
                        : r.kind === "add-machine"
                          ? "add-machine"
                          : r.kind === "machine"
                            ? `machine:${r.machine.origin}`
                            : `new:${r.parent ?? ""}/${r.name}`
      }
      rowClass={(r) =>
        cx("picker-row", (r.kind === "new" || r.kind === "disk" || r.kind === "add-machine") && "new-project-row")
      }
      onQuery={onQuery}
      // a folder completes to itself with a trailing slash, so tab keeps walking down the tree
      completionOf={(r) => (r.kind === "dir" ? (r.entry.isRepo ? r.entry.path : `${r.entry.path}/`) : null)}
      // a plain folder is a step on the way, not a project: descend and keep the picker up
      narrowTo={(r) => (r.kind === "dir" && !r.entry.isRepo ? `${r.entry.path}/` : null)}
      onPick={(r) => {
        // `ask` opens the page, which closes this overlay itself, so those branches return rather
        // than falling through to the close below
        if (r.kind === "clone") return ask("clone", r.name, r.url);
        if (r.kind === "create" && !r.parent) return ask("create", r.name);
        if (r.kind === "new") return ask("create", "");
        // the disk form replaces this one, so this returns ahead of the close below too
        if (r.kind === "disk") return browse();
        if (r.kind === "add-machine") return addMachine();

        if (r.kind === "machine") machines.activate(r.machine.origin);
        else if (r.kind === "pending") dispatch({ a: "watch-import", id: r.pending.id });
        else if (r.kind === "repo" && r.machine) goElsewhere(r.machine.origin, r.repo.id);
        else if (r.kind === "repo") dispatch({ a: "activate-repo", id: r.repo.id });
        else if (r.kind === "open") open(r.path);
        else if (r.kind === "init") initProject(deps, r.path);
        else if (r.kind === "dir")
          open(r.entry.path); // only repo folders get here; narrowTo takes the rest
        else if (r.parent) createAt(r.parent, r.name);
        finish();
      }}
      onBack={goBack}
      // a project row is a project: its setup and its forget are a right-click away, as they are
      // in the palette; a clone still running can be stopped from its row
      rowMenu={(r) =>
        r.kind === "machine"
          ? machineItems(machines, r.machine.origin)
          : r.kind === "repo" && r.machine
            ? machineItems(machines, r.machine.origin)
            : r.kind === "repo"
              ? projectItems(r.repo, current, deps)
              : r.kind === "pending"
                ? importItems(r.pending, deps)
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
                    : active?.kind === "disk"
                      ? "browses"
                      : active?.kind === "add-machine"
                        ? "adds one"
                        : active?.kind === "machine" || (active?.kind === "repo" && active.machine)
                          ? "switches machine"
                          : "opens",
        back: "closes",
      })}
      // an empty query always has the standing rows, so there is always something typed here
      empty="nothing here; keep typing a path (~/… or /…)"
      row={(r) =>
        r.kind === "repo" && r.machine ? (
          <PaletteRow label={r.repo.name} hint={<MachineRepoHint origin={r.machine.origin} repo={r.repo} />} />
        ) : r.kind === "repo" ? (
          <PaletteRow label={r.repo.name} current={r.repo.id === current} hint={hintFor(r.repo)} />
        ) : r.kind === "pending" ? (
          <PaletteRow label={r.pending.name} hint={r.pending.error ? "import failed" : "importing…"} />
        ) : r.kind === "dir" ? (
          <PaletteRow label={r.entry.name} hint={r.entry.isRepo ? "git repo" : undefined} />
        ) : r.kind === "open" ? (
          <PaletteRow label={`open ${r.path}`} hint="register with this daemon" />
        ) : r.kind === "init" ? (
          <PaletteRow label={`open ${r.path}`} hint="no git yet; starts it here with the files in it" />
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
        ) : r.kind === "disk" ? (
          <PaletteRow
            label={
              <>
                <Icon name="folder" className="icon-inline" />
                open folder
              </>
            }
          />
        ) : r.kind === "add-machine" ? (
          <PaletteRow
            label={
              <>
                <Icon name="devices" className="icon-inline" />
                add a machine
              </>
            }
          />
        ) : r.kind === "machine" ? (
          // the head over it says what state it is in; the row is the way there
          <PaletteRow label={`switch to ${machines.displayName(r.machine.origin)}`} />
        ) : (
          <PaletteRow label={`create ${r.name}`} hint={r.parent ? `in ${r.parent}` : "new project"} />
        )
      }
    />
  );
}

/** the worktree counts a project on this machine shows, read from `rows` */
function hintOf(rows: readonly WorktreeStatus[], r: RepoInfo): string | undefined {
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
}

/** another machine's head over its projects: its name, and what it needs of you (or why it cannot
 * say), read off its own store. A count that owes something is the accent, as the bar's is. */
function MachineHead({ origin }: { origin: string }) {
  const machines = useMachines();
  const machine = machines.get(origin) ?? machines.active();
  const rows = useMachineStore(machine, (s) => s.rows);
  const connected = useMachineStore(machine, (s) => s.connected);
  const connectFailure = useMachineStore(machine, (s) => s.connectFailure);
  const incompatible = useMachineStore(machine, (s) => s.incompatible);
  const front = useMachineStore(machine, (s) => s.remote?.front);
  const name = machines.displayName(origin);
  const line = machineLine(name, {
    rows: rows.filter(isOwned),
    connected,
    connectFailure,
    incompatible,
    suspended: (front === "edge" || edgeByOrigin(origin)) && !connected,
  });
  const owed = /^\d+ /.test(line);
  return (
    <>
      {name}
      <span className={cx("picker-group-tail", owed && "picker-group-owed")}>{line}</span>
    </>
  );
}

/** the same counts for a project on another machine, read off that machine's store */
function MachineRepoHint({ origin, repo }: { origin: string; repo: RepoInfo }) {
  const machines = useMachines();
  const machine = machines.get(origin);
  const rows = useMachineStore(machine ?? machines.active(), (s) => s.rows);
  return <>{machine ? hintOf(rows, repo) : null}</>;
}

/** "github.com" out of a URL, for the hint on a clone row. Best effort: a hint is not worth a throw */
function hostOf(url: string): string {
  const m = url.match(/^[a-z+]+:\/\/(?:[^@/]*@)?([^/:]+)/i) ?? url.match(/^[^@]+@([^:]+):/);
  return m?.[1] ?? "git remote";
}
