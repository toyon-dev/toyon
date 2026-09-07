import type { RepoInfo } from "@toyon/shared";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { ListPicker } from "../../ui/ListPicker.tsx";
import { byName } from "./commands.ts";
import { PaletteRow } from "./PaletteRow.tsx";

type Row = { kind: "repo"; repo: RepoInfo } | { kind: "open"; path: string };

/** a typed path is an "open this folder" row; a shell would expand ~ and we let the daemon do it */
const looksLikePath = (q: string) => /^(~|\/|\.\.?\/)/.test(q.trim());

/** ⌘⇧O / the top-left pill: switch the shell to another registered repo, or type a path to
 * register one. The daemon keeps every project's procs running; this only changes what is on screen. */
export function ProjectPicker() {
  const dispatch = useDispatch();
  const sock = useSock();
  const repos = useStore((s) => s.repos);
  const current = useStore((s) => s.activeRepoId);
  const worktrees = useStore((s) => s.worktrees);
  const items: Row[] = repos.map((repo) => ({ kind: "repo", repo }));
  const hintFor = (r: RepoInfo) => {
    const mine = worktrees.filter((w) => w.worktree.repoId === r.id && w.worktree.kind !== "spare");
    const working = mine.filter((w) => w.agent === "working").length;
    const n = mine.length - 1; // main is not a task
    const parts = [n > 0 ? `${n} worktree${n === 1 ? "" : "s"}` : null, working > 0 ? `${working} working` : null];
    return parts.filter(Boolean).join(" · ") || undefined;
  };
  return (
    <ListPicker
      items={items}
      filter={(rows, q) => {
        const hits = rows.filter((r) => r.kind === "repo" && byName(q, r.repo.name, r.repo.path));
        const open: Row = { kind: "open", path: q.trim() };
        return looksLikePath(q) ? [...hits, open] : hits;
      }}
      keyOf={(r) => (r.kind === "repo" ? r.repo.id : `open:${r.path}`)}
      rowClass={() => "cmd-item"}
      initialIndex={(rows) =>
        Math.max(
          0,
          rows.findIndex((r) => r.kind === "repo" && r.repo.id === current),
        )
      }
      onPick={(r) => {
        if (r.kind === "repo") dispatch({ a: "activate-repo", id: r.repo.id });
        else {
          dispatch({ a: "open-repo" });
          sock?.send({ t: "register-repo", path: r.path });
        }
        dispatch({ a: "close" });
      }}
      onBack={() => dispatch({ a: "close", back: true })}
      placeholder={repos.length > 1 ? "switch project, or type a path to open one" : "type a path to open a project"}
      empty={(q) => (q ? "no project matches; type a path (~/… or /…) to open one" : "no projects")}
      row={(r) =>
        r.kind === "repo" ? (
          <PaletteRow label={r.repo.name} current={r.repo.id === current} hint={hintFor(r.repo)} />
        ) : (
          <PaletteRow label={`open ${r.path}`} hint="register with this daemon" />
        )
      }
    />
  );
}
