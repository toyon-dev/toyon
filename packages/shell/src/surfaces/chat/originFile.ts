// The origin's file a piece came from, reached from two places that must agree: the composer's
// line under the box, which points there until this worktree has a plan of its own, and the brief
// row in the log. Both look the origin up, since the file goes with the origin when that is
// archived, and both open it beside the chat as the rendered markdown it is.

import { openFile } from "../../state/actions/file.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { worktreeById } from "../../state/store.ts";

export interface OriginFile {
  worktreeId: string;
  path: string;
}

/** what the file is called: the briefs list Toyon wrote, one heading per piece, or an agent's plan */
export const fileWord = (briefs?: boolean): string => (briefs ? "the briefs" : "the plan");

/** the origin's row while it is listed, and the press that opens the file in the pane */
export function useOriginFile(file: OriginFile | null | undefined): {
  origin: ReturnType<typeof worktreeById>;
  open: () => void;
} {
  const sock = useSock();
  const dispatch = useDispatch();
  const origin = useStore((s) => (file ? worktreeById(s, file.worktreeId) : null));
  const open = () => {
    if (file) openFile({ sock, dispatch }, { worktreeId: file.worktreeId, path: file.path, view: "preview" });
  };
  return { origin, open };
}
