import type { PathEntry, RepoInfo } from "@toyon/shared";
import { useCallback } from "react";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { ListPicker } from "../../ui/ListPicker.tsx";
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
 * drilled into (enter or tab), so a nested checkout is reachable without typing it out. */
export function ProjectPicker() {
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

  const items: Row[] = [
    ...repos.map((repo): Row => ({ kind: "repo", repo })),
    ...paths.entries.map((entry): Row => ({ kind: "dir", entry })),
  ];

  const hintFor = (r: RepoInfo) => {
    const mine = worktrees.filter((w) => w.worktree.repoId === r.id && w.worktree.kind !== "spare");
    const working = mine.filter((w) => w.agent === "working").length;
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
      initialIndex={(rows) =>
        Math.max(
          0,
          rows.findIndex((r) => r.kind === "repo" && r.repo.id === current),
        )
      }
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
      placeholder={repos.length > 1 ? "switch project, or type a path to open one" : "type a path to open a project"}
      keys={{ complete: "completes the path", pick: "opens", back: "closes" }}
      empty={(q) => (q ? "nothing here; keep typing a path (~/… or /…)" : "no projects")}
      row={(r) =>
        r.kind === "repo" ? (
          <PaletteRow label={r.repo.name} current={r.repo.id === current} hint={hintFor(r.repo)} />
        ) : r.kind === "dir" ? (
          <PaletteRow label={r.entry.name} hint={r.entry.isRepo ? "git repo" : "folder"} />
        ) : (
          <PaletteRow label={`open ${r.path}`} hint="register with this daemon" />
        )
      }
    />
  );
}
