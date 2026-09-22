import type { RefHit } from "@toyon/shared";
import { useCallback } from "react";
import { refItems } from "../../state/actions/ref.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { Icon, type IconName } from "../../ui/Icon.tsx";
import { ListPicker } from "../../ui/ListPicker.tsx";
import { PaletteRow } from "./PaletteRow.tsx";

const NONE: RefHit[] = [];
const ICON: Record<RefHit["kind"], IconName> = { branch: "branch", remote: "globe", pr: "pr" };
/** the groups in the order they stand: PRs first, since a PR row carries the most (author, draft,
 * fork) and is the one someone else opened; then the repo's own branches; remotes last, and only
 * ever under a typed query */
const ORDER: Record<RefHit["kind"], number> = { pr: 0, branch: 1, remote: 2 };
const GROUP: Record<RefHit["kind"], string> = { pr: "pull requests", branch: "branches", remote: "remote branches" };

/** ⌘⇧G: open a branch or a PR as a worktree. The rail lists directories; this is where the refs
 * live, behind search, so nine parked branches never crowd it. The daemon ranks, and the filter
 * here only gathers each kind under its own head, keeping the daemon's order inside a group: a
 * PR row and a branch row are read differently, and mixed by recency alone they read as noise on
 * a repo with a team on it. An empty query is the work that is open: unmerged local branches
 * nobody has out, and the open PRs. A ref already checked out somewhere is a switch, not an
 * open, since git would refuse a second worktree on the branch anyway. */
export function RefPicker({ repoId }: { repoId: string }) {
  const dispatch = useDispatch();
  const sock = useSock();
  const clientId = useStore((s) => s.clientId);
  const results = useStore((s) => s.refs[repoId]);
  const rows = useStore((s) => s.rows);
  const nameOf = (id: string) => rows.find((r) => r.id === id)?.name ?? "a worktree";
  const filter = useCallback((hits: RefHit[]) => [...hits].sort((a, b) => ORDER[a.kind] - ORDER[b.kind]), []);
  const onQuery = useCallback((q: string) => sock?.send({ t: "search-refs", repoId, query: q.trim() }), [sock, repoId]);
  // stale = the daemon has not answered this query yet; the previous rows stay up meanwhile
  const isStale = (q: string) => !results || results.query !== q.trim();
  const hint = (h: RefHit) => {
    if (h.openIn) return `open in ${nameOf(h.openIn)}`;
    if (h.merged) return "merged";
    if (h.pr) return `${h.pr.author}${h.pr.draft ? " · draft" : ""}${h.pr.fork ? " · fork" : ""}`;
    return h.subject ?? "";
  };
  return (
    <ListPicker
      items={results?.refs ?? NONE}
      filter={filter}
      onQuery={onQuery}
      keyOf={(h) => `${h.kind}:${h.ref}`}
      rowClass={() => "picker-row ref-row"}
      onPick={(h) => {
        if (h.openIn) dispatch({ a: "activate", id: h.openIn });
        else {
          sock?.send({
            t: "open-ref",
            repoId,
            kind: h.kind,
            ref: h.ref,
            clientId,
            ...(h.pr ? { pr: { title: h.pr.title, url: h.pr.url } } : {}),
          });
        }
        dispatch({ a: "close" });
      }}
      onBack={() => dispatch({ a: "close" })}
      rowMenu={refItems}
      groupOf={(h) => h.kind}
      groupHead={(kind, n) => `${GROUP[kind as RefHit["kind"]]} · ${n}`}
      placeholder="open a branch or PR…"
      keys={(active) => ({
        nav: "moves",
        pick: active?.openIn ? "switches to it" : "opens it as a worktree",
        back: "closes",
      })}
      empty={(q) =>
        isStale(q) ? "looking…" : q.trim() ? "no branch or PR matches" : "no unmerged branches or open PRs"
      }
      row={(h) => (
        <PaletteRow
          label={
            <>
              <Icon name={ICON[h.kind]} className="icon-inline" />
              <span className="ref-name">{h.name}</span>
            </>
          }
          hint={hint(h)}
        />
      )}
    />
  );
}
