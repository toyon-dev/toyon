import type { PathEntry, RepoInfo } from "@toyon/shared";
import { useCallback } from "react";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { ListPicker } from "../../ui/ListPicker.tsx";
import { tip } from "../../ui/Tooltip.tsx";
import { isBusy } from "../util.ts";
import { byName } from "./commands.ts";
import { PaletteRow } from "./PaletteRow.tsx";

type Row =
  | { kind: "repo"; repo: RepoInfo }
  | { kind: "dir"; entry: PathEntry }
  /** the literal text typed, offered when nothing on disk matched it */
  | { kind: "open"; path: string };

/** a typed path is a filesystem query rather than a name filter */
const looksLikePath = (q: string) => /^(~|\/|\.\.?\/)/.test(q.trim());

/** ⌘⇧O / the top-left pill: switch the shell to another registered repo, or type a path to
 * register one. The daemon keeps every project's procs running; this only changes what is on
 * screen. Typing a path completes against the filesystem: repos are openable, plain folders are
 * drilled into (enter or tab), so a nested checkout is reachable without typing it out.
 *
 * Two forms, one component. Normally it drops out of the pill and takes the bar over the way a
 * browser's address bar does: the open project becomes a chip in the field, the caret sits after
 * it, and the rows are the projects you could switch to. `dialog` is the centered form the field's
 * folder button opens, which starts in the home directory: more room for walking the filesystem,
 * where the anchored one would run out of screen. */
export function ProjectPicker({ dialog = false }: { dialog?: boolean }) {
  const dispatch = useDispatch();
  const sock = useSock();
  const repos = useStore((s) => s.repos);
  const current = useStore((s) => s.activeRepoId);
  const worktrees = useStore((s) => s.worktrees);
  const paths = useStore((s) => s.paths);

  // debounced by the picker; only path-shaped queries reach the daemon
  const onQuery = useCallback(
    (q: string) => {
      if (looksLikePath(q)) sock?.send({ t: "browse-path", path: q });
    },
    [sock],
  );

  // the open project is the chip in the field, so listing it again would only be a row that
  // changes nothing. Directories come back alphabetical; the ones that are repos are the ones you
  // came here to open, so they lead and the rest keep their order under them.
  const dirs = [...paths.entries].sort((a, b) => Number(b.isRepo) - Number(a.isRepo));
  const items: Row[] = [
    ...repos.filter((repo) => repo.id !== current).map((repo): Row => ({ kind: "repo", repo })),
    ...dirs.map((entry): Row => ({ kind: "dir", entry })),
  ];

  const hintFor = (r: RepoInfo) => {
    const mine = worktrees.filter((w) => w.worktree.repoId === r.id && w.worktree.kind !== "spare");
    const working = mine.filter(isBusy).length;
    const n = mine.length - 1; // main is not a task
    const parts = [n > 0 ? `${n} worktree${n === 1 ? "" : "s"}` : null, working > 0 ? `${working} working` : null];
    return parts.filter(Boolean).join(" · ") || undefined;
  };

  const open = (path: string) => {
    dispatch({ a: "open-repo" });
    sock?.send({ t: "register-repo", path });
    dispatch({ a: "close" });
  };

  return (
    <ListPicker
      anchored={!dialog}
      initialQuery={dialog ? "~/" : ""}
      // the chip says what you are switching away from, which is only true of the bar panel: the
      // dialog is a path browser and nothing in it is scoped to the open project
      lead={
        dialog ? undefined : (
          <span className="lp-chip">{repos.find((r) => r.id === current)?.name ?? "no project"}</span>
        )
      }
      trailing={
        dialog ? undefined : (
          <button
            type="button"
            className="btn-icon"
            {...tip("Find a project on disk")}
            onClick={() => dispatch({ a: "open", overlay: { kind: "projects", dialog: true } })}
          >
            <Icon name="folder" />
          </button>
        )
      }
      items={items}
      filter={(rows, q) => {
        if (!looksLikePath(q)) return rows.filter((r) => r.kind === "repo" && byName(q, r.repo.name, r.repo.path));
        // the daemon already matched these against the path; re-filtering here would only fight
        // the debounce and blank the list between keystrokes
        const dirs = rows.filter((r) => r.kind === "dir");
        const typed = q.trim();
        if (dirs.length > 0) return dirs;
        const literal: Row = { kind: "open", path: typed };
        return [literal];
      }}
      keyOf={(r) => (r.kind === "repo" ? r.repo.id : r.kind === "dir" ? `d:${r.entry.path}` : `open:${r.path}`)}
      rowClass={() => "cmd-item"}
      onQuery={onQuery}
      // a folder completes to itself with a trailing slash, so tab keeps walking down the tree
      completionOf={(r) => (r.kind === "dir" ? (r.entry.isRepo ? r.entry.path : `${r.entry.path}/`) : null)}
      // a plain folder is a step on the way, not a project: descend and keep the picker up
      narrowTo={(r) => (r.kind === "dir" && !r.entry.isRepo ? `${r.entry.path}/` : null)}
      onPick={(r) => {
        if (r.kind === "repo") dispatch({ a: "activate-repo", id: r.repo.id });
        else if (r.kind === "open") open(r.path);
        else open(r.entry.path);
        dispatch({ a: "close" });
      }}
      onBack={() => dispatch({ a: "close", back: true })}
      placeholder={repos.length > 1 ? "switch project, or type a path" : "type a path to open a project"}
      keys={(active) => ({
        complete: "completes the path",
        // a plain folder is a step on the way: enter walks into it rather than opening anything
        pick: active?.kind === "dir" && !active.entry.isRepo ? "descends" : "opens",
        back: "closes",
      })}
      empty={(q) => (q ? "nothing here; keep typing a path (~/… or /…)" : "no other projects; type a path to open one")}
      row={(r) =>
        r.kind === "repo" ? (
          <PaletteRow label={r.repo.name} hint={hintFor(r.repo)} />
        ) : r.kind === "dir" ? (
          <PaletteRow label={r.entry.name} hint={r.entry.isRepo ? "git repo" : undefined} />
        ) : (
          <PaletteRow label={`open ${r.path}`} hint="register with this daemon" />
        )
      }
    />
  );
}
