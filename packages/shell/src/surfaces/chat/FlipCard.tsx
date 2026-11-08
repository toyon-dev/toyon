// The flip's note as a card: Toyon started a shared command here because this worktree's edit
// touched its files, and the places it could run instead (main's, its own, a remote) are rows
// under the sentence, the same rows the chip beside the composer opens into, since the moment to
// redirect is in the chat and the chip is not. The flip is already in motion when the card lands,
// so nothing waits on it: a press is a redirect, not an answer, and there is no default and no
// lapse. The card reads the record live: moved on the chip, its mark follows and its sentence
// says where the command stands; archived, or the command no longer shared, it is history with
// no rows. One card per command the flip took, since the rows are a command's.

import { useSock, useStore } from "../../state/context.tsx";
import { type ChatItem, repoById, trunkOf, worktreeById } from "../../state/store.ts";
import { Choices } from "../../ui/Choices.tsx";
import { pickSource } from "../chips/SourceChip.tsx";
import { DaemonRow } from "./DaemonRow.tsx";
import { flipCard } from "./flipCard.ts";

export function FlipCard({
  item,
  worktreeId,
}: {
  item: Extract<ChatItem, { kind: "owned" }>;
  worktreeId?: string | null;
}) {
  return (
    <>
      {item.names.map((name) => (
        <FlipOne key={name} name={name} file={item.file} ts={item.ts} worktreeId={worktreeId} />
      ))}
    </>
  );
}

function FlipOne({
  name,
  file,
  ts,
  worktreeId,
}: {
  name: string;
  file: string | undefined;
  ts: number;
  worktreeId?: string | null;
}) {
  const sock = useSock();
  const wt = useStore((s) => worktreeById(s, worktreeId));
  const repo = useStore((s) => repoById(s, wt?.repoId));
  const trunk = useStore((s) => trunkOf(s, wt?.repoId));
  const card = flipCard(name, file, wt, repo, trunk);
  const live = wt && card.value !== null ? { id: wt.worktree.id, value: card.value } : null;
  return (
    <DaemonRow
      icon="run"
      word={card.word}
      tone="quiet"
      at={ts}
      under={
        live && (
          <Choices
            hover
            plain
            rows={card.rows.map((r) => ({ label: r.label ?? r.id, description: r.description, checked: r.current }))}
            onPick={(i) => {
              const to = card.rows[i];
              if (to) pickSource(sock, name, live.value, to.id, live.id);
            }}
          />
        )
      }
    >
      <span className="daemon-text">{card.text}</span>
    </DaemonRow>
  );
}
