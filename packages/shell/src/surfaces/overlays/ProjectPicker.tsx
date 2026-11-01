import { isOwned, projectOrder } from "@toyon/shared";
import { useCallback, useMemo, useRef } from "react";
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
import { openTypedPath } from "../../state/openOutside.ts";
import { newProjectState, type ProjectsOverlay } from "../../state/store.ts";
import { IconButton } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { Icon } from "../../ui/Icon.tsx";
import { ListPicker } from "../../ui/ListPicker.tsx";
import type { Anchored } from "../../ui/Overlay.tsx";
import { PaletteRow } from "./PaletteRow.tsx";
import { defaultParent, looksLikePath, type Row, rowsFor } from "./projectPicker.ts";

/** ⌘O / the top-left pill: switch the shell to another registered repo, type a path to open one
 * (or a file), or make one that is not there yet. Switching only changes what is on screen; the
 * daemon keeps every project's procs running. A typed path completes against the filesystem, a
 * folder with no git in it is offered as a project to start where it is, a file opens in the
 * editor, and a name or git URL matching nothing becomes an offer to create or clone.
 *
 * Three forms, one component: `pill` drops out of the pill and takes the bar over like an address
 * bar; `center` is the same switcher over the preview, where the eyes are when a key opened it;
 * `disk` is the centred form the folder button opens, starting in the home directory, since the
 * anchored one runs out of screen when walking the filesystem; `url` is the centred form that asks
 * for a git URL, the same clone row as pasting one into the switcher, for someone who did not know. */
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
  // the daemon can put a Finder dialog where the person is: a local macOS daemon
  const canAskFinder = useStore((s) => s.folderDialog);
  const fromUrl = form === "url";
  // what is typed, for the Finder dialog to open in the folder being walked
  const typed = useRef("");
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
      typed.current = q;
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
        urlOnly: fromUrl,
      }),
    [ordered, paths, pending, home, others, current, fromUrl],
  );

  const finish = () => dispatch({ a: "close" });
  const goBack = () => dispatch({ a: "close", back: true });

  const deps = { sock, dispatch };
  const open = (path: string) => openProject(deps, { t: "register-repo", path });
  /** a typed path already named its destination, so there is nothing left to ask about */
  const createAt = (parent: string, name: string) =>
    openProject(deps, { t: "create-repo", mode: "create", parent, name });

  /** the new-project view, for the rows where something would otherwise be guessed */
  const ask = (mode: "create" | "clone", name: string, src?: { url: string; branch?: string }) =>
    dispatch({
      a: "new-project",
      v: newProjectState({
        mode,
        name,
        // a bare name says nothing about location: offer wherever the other projects already live
        parent: defaultParent(repos, current, home),
        ...src,
      }),
    });

  /** the disk form: the folder button and the "open folder" row are one way in, said twice */
  const browse = () => dispatch({ a: "open", overlay: { kind: "projects", form: "disk" } });
  /** the url form: the same switcher asking for one thing, so pasting is the whole of it */
  const askUrl = () => dispatch({ a: "open", overlay: { kind: "projects", form: "url" } });
  /** a file picked in Finder opens as a typed one does; the dialog starts in the folder being
   * walked, and the picker goes, since the dialog is where the choosing happens now */
  const chooseFile = () => {
    const q = typed.current.trim();
    const cut = q.lastIndexOf("/");
    const start = looksLikePath(q) && cut >= 0 ? q.slice(0, cut) || "/" : "~";
    sock?.send({ t: "choose-file", start });
    finish();
  };
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
      // and url forms ask for one thing each and nothing in them is scoped to the open project
      lead={
        form === "disk" || fromUrl ? undefined : (
          <span className="picker-chip">{repos.find((r) => r.id === current)?.name ?? "no project"}</span>
        )
      }
      trailing={
        fromUrl ? undefined : form === "disk" ? (
          canAskFinder ? (
            <IconButton icon="file" label="Open a file from Finder" onClick={chooseFile} />
          ) : undefined
        ) : (
          <IconButton icon="folder" label="Find a project or file on disk" onClick={browse} />
        )
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
            : r.kind === "file"
              ? `f:${r.entry.path}`
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
                          : r.kind === "from-url"
                            ? "from-url"
                            : r.kind === "add-machine"
                              ? "add-machine"
                              : r.kind === "machine"
                                ? `machine:${r.machine.origin}`
                                : `new:${r.parent ?? ""}/${r.name}`
      }
      rowClass={(r) =>
        cx(
          "picker-row",
          (r.kind === "new" || r.kind === "disk" || r.kind === "from-url" || r.kind === "add-machine") &&
            "new-project-row",
        )
      }
      onQuery={onQuery}
      // a folder completes to itself with a trailing slash, so tab keeps walking down the tree; a
      // file is the end of the path
      completionOf={(r) =>
        r.kind === "dir"
          ? r.entry.isRepo
            ? r.entry.path
            : `${r.entry.path}/`
          : r.kind === "file"
            ? r.entry.path
            : null
      }
      // a plain folder is a step on the way, not a project: descend and keep the picker up
      narrowTo={(r) => (r.kind === "dir" && !r.entry.isRepo ? `${r.entry.path}/` : null)}
      onPick={(r) => {
        // `ask` opens the page, which closes this overlay itself, so those branches return rather
        // than falling through to the close below
        if (r.kind === "clone") return ask("clone", r.name, { url: r.url, ...(r.branch ? { branch: r.branch } : {}) });
        if (r.kind === "create" && !r.parent) return ask("create", r.name);
        if (r.kind === "new") return ask("create", "");
        // the disk and url forms replace this one, so these return ahead of the close below too
        if (r.kind === "disk") return browse();
        if (r.kind === "from-url") return askUrl();
        if (r.kind === "add-machine") return addMachine();

        if (r.kind === "machine") machines.activate(r.machine.origin);
        else if (r.kind === "pending") dispatch({ a: "watch-import", id: r.pending.id });
        else if (r.kind === "repo" && r.machine) goElsewhere(r.machine.origin, r.repo.id);
        else if (r.kind === "repo") dispatch({ a: "activate-repo", id: r.repo.id });
        else if (r.kind === "open") open(r.path);
        else if (r.kind === "file") openTypedPath(sock, r.entry.path);
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
              ? projectItems(r.repo, current, deps, rows)
              : r.kind === "pending"
                ? importItems(r.pending, deps)
                : []
      }
      placeholder={
        fromUrl
          ? "paste a git URL, like https://github.com/you/app"
          : repos.length > 1
            ? "switch project, or type a name or path"
            : "type a name or a path to start"
      }
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
                      : active?.kind === "from-url"
                        ? "asks for one"
                        : active?.kind === "add-machine"
                          ? "adds one"
                          : active?.kind === "machine" || (active?.kind === "repo" && active.machine)
                            ? "switches machine"
                            : "opens",
        back: "closes",
      })}
      // an empty query always has the standing rows, so there is always something typed here; the
      // url form has nothing until a URL is, and says what it takes
      empty={
        fromUrl
          ? (q) =>
              q.trim()
                ? "not a git URL yet; paste the address of a repository, or of a page on GitHub, GitLab or Codeberg"
                : "the address of a repository, or of a branch, file or pull request on GitHub, GitLab or Codeberg"
          : "nothing here; keep typing a path (~/… or /…)"
      }
      row={(r) =>
        // the name alone: the worktree counts are the rail's, and on a phone they crowded the name out
        r.kind === "repo" ? (
          <PaletteRow label={r.repo.name} current={!r.machine && r.repo.id === current} />
        ) : r.kind === "pending" ? (
          <PaletteRow
            label={r.pending.name}
            hint={r.pending.error ? "import failed" : <span className="live-text">importing</span>}
          />
        ) : r.kind === "dir" ? (
          <PaletteRow label={r.entry.name} hint={r.entry.isRepo ? "git repo" : undefined} />
        ) : r.kind === "file" ? (
          <PaletteRow label={r.entry.name} hint="file" />
        ) : r.kind === "open" ? (
          <PaletteRow label={`open ${r.path}`} hint="register with this daemon" />
        ) : r.kind === "init" ? (
          <PaletteRow label={`open ${r.path}`} hint="no git yet; starts it here with the files in it" />
        ) : r.kind === "clone" ? (
          <PaletteRow label={`clone ${r.name}`} hint={r.branch ? `${hostOf(r.url)} · ${r.branch}` : hostOf(r.url)} />
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
                open folder or file
              </>
            }
          />
        ) : r.kind === "from-url" ? (
          <PaletteRow
            label={
              <>
                <Icon name="globe" className="icon-inline" />
                clone from a URL
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

/** "github.com" out of a URL, for the hint on a clone row. Best effort: a hint is not worth a throw */
function hostOf(url: string): string {
  const m = url.match(/^[a-z+]+:\/\/(?:[^@/]*@)?([^/:]+)/i) ?? url.match(/^[^@]+@([^:]+):/);
  return m?.[1] ?? "git remote";
}
