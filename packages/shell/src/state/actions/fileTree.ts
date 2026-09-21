import { isMain, isOwned } from "@toyon/shared";
import { grouped, type MenuEntry, type MenuItem } from "../../ui/menu.ts";
import { askAgent, mentionInChat, mentionOf, treeBox } from "../attach.ts";
import type { Store } from "../context.tsx";
import { readingView, rowById, type State } from "../store.ts";
import { copyText, type Deps } from "./deps.ts";
import { editorItems, revealItems } from "./editor.ts";
import { openFile } from "./file.ts";

/** Why the tree may not make a file here, or undefined when it may. Main is the launcher: a file
 * made there stays behind unless the changes are brought along, so it waits for a worktree. A
 * worktree toyon only found is not one it writes in. */
export function fileChangeBlocked(s: Pick<State, "rows">, worktreeId: string): string | undefined {
  const row = rowById(s, worktreeId);
  if (!row || !isOwned(row)) return "take this worktree over to change files here";
  if (isMain(row.worktree)) return "start a worktree to change files";
  return undefined;
}

/** the one thing the tree makes itself: an empty file, named in a row where `dir` opens */
function newFileItem(store: Store, worktreeId: string, dir: string, newFile: (dir: string) => void): MenuItem {
  return {
    id: "new-file",
    label: "new file…",
    disabled: fileChangeBlocked(store.getState(), worktreeId),
    onClick: () => newFile(dir),
  };
}

/** A row in the files tab. The tree reads and points: open the file or name it to the agent, then
 * show where it is, then change the project's shape. A new file is the tree's own, since an empty
 * file breaks nothing and what goes in it is typed in the editor pane. Renaming and deleting are
 * the agent's, because a rename breaks imports and a moved page changes its URL, and the agent
 * fixes both where a file operation would not; so those entries leave a sentence in the box and
 * send nothing. Editor rows stay off this menu, since the file's own view carries them once it is
 * open. `newIn` is the folder a new file made from this row goes in: the row itself for a folder,
 * the folder holding it for a file. */
export function treeItems(
  row: { worktreeId: string; dir: string; path: string; folder: boolean; newIn: string },
  store: Store,
  deps: Deps,
  newFile: (dir: string) => void,
): MenuEntry[] {
  const { worktreeId, dir, path, folder, newIn } = row;
  // a worktree toyon only found has no composer to take the words
  const noChat = treeBox(store.getState(), worktreeId) ? undefined : "take this worktree over to talk to an agent here";
  const named = mentionOf(path, folder);
  const chat: MenuItem[] = [
    ...(folder
      ? []
      : [{ id: "open", label: "open", onClick: () => openFile(deps, { worktreeId, path, view: readingView(path) }) }]),
    {
      id: "add-to-chat",
      label: "add to chat",
      disabled: noChat,
      onClick: () => mentionInChat(store, worktreeId, path, folder),
    },
  ];
  const shape: MenuItem[] = [
    newFileItem(store, worktreeId, newIn, newFile),
    {
      id: "ask-rename",
      label: "ask the agent to rename…",
      disabled: noChat,
      onClick: () => askAgent(store, worktreeId, `Rename ${named} to `),
    },
    {
      id: "ask-delete",
      label: "ask the agent to delete…",
      disabled: noChat,
      onClick: () => askAgent(store, worktreeId, `Delete ${named} and update whatever still uses it`),
    },
  ];
  // where the file is: shown in Finder, or its path on the clipboard
  const where: MenuItem[] = [
    ...revealItems(() => deps.sock?.send({ t: "reveal", worktreeId, path })),
    { id: "copy-path", label: "copy path", onClick: () => copyText(`${dir}/${path}`) },
    { id: "copy-relative-path", label: "copy relative path", onClick: () => copyText(path) },
  ];
  return grouped([chat, where, shape]);
}

/** the tree's empty space: a file at the root, then the worktree itself, in an editor or in Finder */
export function treeSpaceItems(
  wt: { worktreeId: string; dir: string },
  store: Store,
  deps: Deps,
  newFile: (dir: string) => void,
): MenuEntry[] {
  return grouped([
    [newFileItem(store, wt.worktreeId, "", newFile)],
    editorItems(wt.dir, () => deps.sock?.send({ t: "reveal", worktreeId: wt.worktreeId })),
  ]);
}
