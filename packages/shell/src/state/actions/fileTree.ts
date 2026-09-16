import { grouped, type MenuEntry, type MenuItem } from "../../ui/menu.ts";
import { askAgent, mentionInChat, mentionOf, treeBox } from "../attach.ts";
import type { Store } from "../context.tsx";
import { readingView } from "../store.ts";
import { copyText, type Deps } from "./deps.ts";
import { editorItems } from "./editor.ts";
import { openFile } from "./file.ts";

/** A row in the files tab. The tree reads and points: open the file, name it to the agent, copy
 * where it is, open it elsewhere. Renaming and deleting are the agent's, because a rename breaks
 * imports and a moved page changes its URL, and the agent fixes both where a file operation would
 * not; so those entries leave a sentence in the box and send nothing. */
export function treeItems(
  row: { worktreeId: string; dir: string; path: string; folder: boolean },
  store: Store,
  deps: Deps,
): MenuEntry[] {
  const { worktreeId, dir, path, folder } = row;
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
  const ask: MenuItem[] = [
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
  const abs = `${dir}/${path}`;
  const copy: MenuItem[] = [
    { id: "copy-path", label: "copy path", onClick: () => copyText(abs) },
    { id: "copy-relative-path", label: "copy relative path", onClick: () => copyText(path) },
  ];
  const elsewhere = editorItems(abs, () => deps.sock?.send({ t: "reveal", worktreeId, path }));
  return grouped([chat, ask, copy, elsewhere]);
}

/** the tree's empty space: the worktree itself, in an editor or in Finder */
export function treeSpaceItems(wt: { worktreeId: string; dir: string }, deps: Deps): MenuEntry[] {
  return editorItems(wt.dir, () => deps.sock?.send({ t: "reveal", worktreeId: wt.worktreeId }));
}
