import type { ArchivedWorktree } from "@toyon/shared";
import { useCallback, useEffect } from "react";
import { archivedHint, archivedItems, restoreArchived } from "../../state/actions/archive.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { ListPicker } from "../../ui/ListPicker.tsx";
import { PaletteRow } from "./PaletteRow.tsx";

const NONE: ArchivedWorktree[] = [];

const matches = (a: ArchivedWorktree, needle: string) =>
  [a.title, a.branch, a.prompt ?? ""].some((field) => field.toLowerCase().includes(needle));

/** A project's removed worktrees. Removing archives rather than deletes, so this is where a remove
 * is undone and where a landed branch's conversation comes back to be read. Enter restores the
 * worktree whole; deleting one for good is on its row's menu, since that cannot be undone. */
export function ArchivePicker({ repoId }: { repoId: string }) {
  const dispatch = useDispatch();
  const sock = useSock();
  const clientId = useStore((s) => s.clientId);
  const items = useStore((s) => s.archived[repoId]);
  // asked for on open rather than carried on hello: nobody reads the list until they open it
  useEffect(() => {
    sock?.send({ t: "list-archived", repoId });
  }, [sock, repoId]);
  const filter = useCallback((all: ArchivedWorktree[], q: string) => {
    const needle = q.trim().toLowerCase();
    return needle ? all.filter((a) => matches(a, needle)) : all;
  }, []);
  return (
    <ListPicker
      items={items ?? NONE}
      filter={filter}
      keyOf={(a) => a.id}
      rowClass={(a) => (a.restorable ? "picker-row" : "picker-row dim")}
      rowTitle={(a) => a.prompt ?? a.title}
      onPick={(a) => {
        if (!a.restorable) return;
        restoreArchived(sock, a.id, clientId);
        dispatch({ a: "close" });
      }}
      onBack={() => dispatch({ a: "close" })}
      rowMenu={(a) => archivedItems(a, clientId, { sock, dispatch })}
      placeholder="find an archived worktree…"
      keys={(active) => ({ nav: "moves", pick: active?.restorable ? "restores it" : undefined, back: "closes" })}
      empty={(q) =>
        !items
          ? "looking…"
          : q.trim()
            ? "no archived worktree matches"
            : "nothing archived: removed worktrees land here"
      }
      row={(a) => <PaletteRow label={a.title} hint={archivedHint(a)} />}
    />
  );
}
