import type { ArchivedWorktree } from "@toyon/shared";
import { dollars } from "../../surfaces/chat/usage.ts";
import { ago } from "../../surfaces/util.ts";
import { grouped, type MenuEntry, type MenuItem } from "../../ui/menu.ts";
import type { DaemonSocket } from "../../ws.ts";
import { copyText, type Deps } from "./deps.ts";

/** what an archived worktree's row says beside its title, in the picker and on the rail: how it
 * ended, what came with it, what its agent cost, and how long ago. The spend alone, no context
 * figure: the context it filled is gone with the session, the money is not. */
export function archivedHint(a: ArchivedWorktree): string {
  const parts = [a.landed ? "merged" : a.uncommitted ? "uncommitted changes" : null];
  if (!a.restorable) parts.push("commits not kept");
  if (a.cost !== undefined) parts.push(dollars(a.cost));
  parts.push(ago(a.archivedAt));
  return parts.filter(Boolean).join(" · ");
}

/** bring an archived worktree back; this tab focuses its row when the daemon lists it */
export function restoreArchived(sock: DaemonSocket | null, archiveId: string, clientId: string) {
  sock?.send({ t: "restore-worktree", archiveId, clientId });
}

/** an archived worktree: bring it back, or let it go. Deleting is the one verb here that cannot be
 * undone, so it asks and sits apart. */
export function archivedItems(a: ArchivedWorktree, clientId: string, { sock, dispatch }: Deps): MenuEntry[] {
  const back: MenuItem[] = [
    {
      id: "restore",
      label: "restore",
      disabled: a.restorable ? undefined : "its commits were not kept",
      onClick: () => {
        restoreArchived(sock, a.id, clientId);
        dispatch({ a: "close" });
      },
    },
  ];
  const copy: MenuItem[] = [{ id: "copy-branch", label: "copy branch name", onClick: () => copyText(a.branch) }];
  const gone: MenuItem[] = [
    {
      id: "delete",
      label: "delete for good…",
      danger: true,
      onClick: () => {
        if (
          window.confirm(
            `Delete "${a.title}" for good?\n\nIts chat, attachments and kept commits are deleted, and it can no longer be restored.`,
          )
        )
          sock?.send({ t: "delete-archived", archiveId: a.id });
      },
    },
  ];
  return grouped([back, copy, gone]);
}
