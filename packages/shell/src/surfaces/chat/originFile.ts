// The origin's file a piece came from, reached from two places that must agree: the composer's
// line under the box, which points there until this worktree has a plan of its own, and the brief
// row in the log. Both look the origin up, since the file goes with the origin when that is
// archived, and both open it beside the chat as the rendered markdown it is. The archive keeps its
// plans, so the file is there to open while the origin stands on the rail or in the archive; only
// an origin gone from both lists has nothing to open.

import { useEffect } from "react";
import { openFile } from "../../state/actions/file.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { worktreeById } from "../../state/store.ts";

export interface OriginFile {
  worktreeId: string;
  /** the origin's project: whose archive names the origin once it is off the rail */
  repoId: string;
  path: string;
}

/** what the file is called: the briefs list Toyon wrote, one heading per piece, or an agent's plan */
export const fileWord = (briefs?: boolean): string => (briefs ? "the briefs" : "the plan");

/** whether the origin is still in either list, so the file is there to open, and the press that
 * opens it in the pane. The rail asks for the archive of the project on screen only, and a
 * handoff's origin is in another: an origin found in neither list asks for its project's archive
 * here, once, and reads as kept when the list arrives with it. */
export function useOriginFile(file: OriginFile | null | undefined): { kept: boolean; open: () => void } {
  const sock = useSock();
  const dispatch = useDispatch();
  const repoId = file?.repoId;
  const live = useStore((s) => !!file && !!worktreeById(s, file.worktreeId));
  const archive = useStore((s) => (repoId ? s.archived[repoId] : undefined));
  const kept = live || (!!file && !!archive?.some((a) => a.id === file.worktreeId));
  useEffect(() => {
    if (sock && repoId && !live && !archive) sock.send({ t: "list-archived", repoId });
  }, [sock, repoId, live, archive]);
  const open = () => {
    if (file) openFile({ sock, dispatch }, { worktreeId: file.worktreeId, path: file.path, view: "preview" });
  };
  return { kept, open };
}
