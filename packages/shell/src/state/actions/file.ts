import { type GitFileStatus, isMarkdown } from "@toyon/shared";
import { grouped, type MenuEntry, type MenuItem } from "../../ui/menu.ts";
import { type EditorView, EMPTY_LOCAL, type OpenFile, type State } from "../store.ts";
import { copyText, type Deps } from "./deps.ts";
import { editorItems } from "./editor.ts";

/**
 * What decides that the file list is stale: the commit checked out, and the paths git says were
 * added, deleted or are untracked. An edit to a file that exists changes none of it, so an agent's
 * tool calls do not refetch the list. HEAD catches a rebase or pull that adds files while the
 * status stays clean; it also refetches after a plain commit, which costs one listing.
 */
export function listingKey(head: string | undefined, status: readonly GitFileStatus[]): string {
  const moved: string[] = [];
  for (const s of status) {
    if (s.xy.includes("D")) moved.push(`-${s.path}`);
    else if (/[?ARC]/.test(s.xy)) moved.push(`+${s.path}`);
  }
  return `${head ?? ""}\n${moved.sort().join("\n")}`;
}

/** Ask for the worktree's files unless the list in hand is still good. Every reader comes here
 * (⌘P, the @ menu, the files tab), so the one cached list is refreshed by whichever opens first
 * and left alone by the rest; git-status arrives after every tool call, and the key says whether
 * the set of files can have moved since the list was asked for. */
export function listFiles(worktreeId: string, s: Pick<State, "local">, { sock, dispatch }: Deps) {
  if (!sock) return;
  const l = s.local[worktreeId] ?? EMPTY_LOCAL;
  const key = listingKey(l.git?.head, l.git?.files ?? []);
  if (l.filesFor === key) return;
  dispatch({ a: "files-asked", worktreeId, key });
  sock.send({ t: "list-files", worktreeId });
}

const VIEWS: EditorView[] = ["diff", "file", "preview"];

/** the views a file has: a markdown file can be read rendered, and a file new to the branch has no diff */
export const viewsOf = (path: string, added: boolean): EditorView[] =>
  VIEWS.filter((v) => !(v === "preview" && !isMarkdown(path)) && !(v === "diff" && added));

let lastSeq = 0;
/** pairs a request with its answer; one counter for the page, so no two opens share a number */
export const nextSeq = () => ++lastSeq;

/** what a caller asks to open; the keyboard follows unless the caller is walking a list */
export type OpenRequest = Omit<OpenFile, "seq" | "focus"> & { focus?: boolean };

/** Open a file in the editor pane: as its diff or as the file (unsaid, the read decides), at a
 * line, or as a commit left it (`ref`). The pane opens now, loading; fileSync sees the open, reads
 * the file and keeps it in step with the disk from there. */
export function openFile({ dispatch }: Deps, { focus = true, ...target }: OpenRequest) {
  dispatch({ a: "open-file", v: { ...target, focus, seq: nextSeq() } });
}

/** Show a folder in the files tab, open, with the tree's cursor on it. The editor reads files and
 * has nothing to show for a folder; the tree is where one is looked into. */
export function openFolder({ dispatch }: Deps, target: { worktreeId: string; path: string }) {
  dispatch({ a: "tree-reveal", ...target });
}

/** a file in the changes panel: show it in the editor pane as its diff or as the file, open it
 * somewhere else, copy where it is, and for an uncommitted one, throw it away. `showing` is the view the pane already
 * has this file in, which the menu swaps rather than reads again; `ref` is the commit a history row
 * stands for; `added` says the file has nothing on the other side, so no diff to offer; `kept` says
 * only git holds it, so there is nothing on disk to open elsewhere or reveal. */
export function fileItems(
  wt: { id: string; dir: string },
  path: string,
  {
    discard = false,
    ref,
    showing,
    added = false,
    kept = false,
  }: { discard?: boolean; ref?: string; showing?: EditorView; added?: boolean; kept?: boolean },
  deps: Deps,
): MenuEntry[] {
  const { sock, dispatch } = deps;
  const views: MenuItem[] = viewsOf(path, added)
    .filter((v) => v !== showing)
    .map((v) => ({
      id: `view:${v}`,
      label: `view ${v}`,
      onClick: () =>
        showing ? dispatch({ a: "editor-view", v }) : openFile(deps, { worktreeId: wt.id, path, view: v, ref }),
    }));
  const abs = `${wt.dir}/${path}`;
  const open = kept ? [] : editorItems(abs, () => sock?.send({ t: "reveal", worktreeId: wt.id, path }));
  const copy: MenuItem[] = [{ id: "copy-path", label: "copy path", onClick: () => copyText(abs) }];
  const discardItems = discard
    ? [
        {
          id: "discard",
          label: "discard changes…",
          danger: true,
          onClick: () => {
            if (window.confirm(`Discard uncommitted changes to ${path}?`)) {
              sock?.send({ t: "discard-file", worktreeId: wt.id, path });
            }
          },
        },
      ]
    : [];
  return grouped([views, copy, open, discardItems]);
}
