import type { RepoInfo } from "@toyon/shared";
import { useMemo } from "react";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { useLocalField } from "../../state/selectors.ts";
import { worktreeById } from "../../state/store.ts";
import { ListPicker } from "../../ui/ListPicker.tsx";
import { byName } from "./commands.ts";
import { PaletteRow } from "./PaletteRow.tsx";

/** The verb's picker: which other open project this worktree's work continues in. Picking one
 * asks this worktree's agent to propose the handoff there, with whatever is in the composer as the
 * person's own words, and the card follows in the box. The words went with the ask, so the box
 * empties the way a send empties it: here and at the daemon, which holds every box's draft. */
export function HandoffPicker({ worktreeId }: { worktreeId: string }) {
  const dispatch = useDispatch();
  const sock = useSock();
  const clientId = useStore((s) => s.clientId);
  const wt = useStore((s) => worktreeById(s, worktreeId));
  const repos = useStore((s) => s.repos);
  const draft = useLocalField(worktreeId, "draft");
  const text = draft.trim();
  const others = useMemo(() => repos.filter((r) => r.id !== wt?.worktree.repoId), [repos, wt]);
  const close = () => dispatch({ a: "close" });
  const pick = (r: RepoInfo) => {
    if (!wt) return close();
    sock?.send({ t: "handoff-ask", worktreeId, repoId: r.id, ...(text ? { text } : {}) });
    if (text) {
      sock?.send({ t: "set-draft", boxId: worktreeId, text: "", clientId });
      dispatch({ a: "set-draft", id: worktreeId, text: "" });
    }
    close();
  };
  return (
    <ListPicker<RepoInfo>
      lead={<span className="picker-chip">{wt?.worktree.title ?? "worktree"}</span>}
      items={others}
      filter={(items, q) => items.filter((r) => byName(q, r.name, r.path))}
      keyOf={(r) => r.id}
      row={(r) => <PaletteRow label={r.name} hint={r.path} />}
      onPick={pick}
      onBack={() => dispatch({ a: "close", back: true })}
      placeholder="continue in which project?"
      empty="no other project is open"
      keys={{ pick: "continues there", back: "closes" }}
      // the words in the box go with the pick, so the picker says so before they do
      footer={text ? () => <div className="empty">with your message: {text.split("\n")[0]}</div> : undefined}
    />
  );
}
