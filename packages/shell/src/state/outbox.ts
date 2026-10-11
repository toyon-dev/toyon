// The outbox: a message between the press and the wire. A send takes the box at once, whatever is
// still uploading, and the message waits in a box of its own until every upload it names has its
// id, which is when the daemon can be told about it. An outgoing box is an ordinary box to
// everything else: the draft and attachment syncs name its uploads to the daemon as they land, an
// upload still on its way follows its chip there, and the daemon puts the message back into it
// when no agent takes it, which this side routes to the box it left.

import type { AttachmentInput, AttachmentKind, ClientMsg } from "@toyon/shared";
import { isUploading, type PendingAttachment, settledInputs } from "./pending.ts";

/** `Omit` over each member of a union, rather than over what the members share */
type Less<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** the frames a message goes as, less what the outgoing box holds and fills in when it goes: the
 * words are its draft (an ask's answer carries its own, and the draft is the row's), the
 * attachments its chips as they stand then, and the box is itself */
export type HeldFrame =
  | Less<Extract<ClientMsg, { t: "chat" }>, "text" | "attachments" | "boxId">
  | Less<Extract<ClientMsg, { t: "create-worktree" }>, "prompt" | "attachments" | "boxId">
  | Less<Extract<ClientMsg, { t: "restore-worktree" | "adopt-worktree" }>, "message" | "boxId">
  | Less<Extract<ClientMsg, { t: "agent-answer" }>, "attachments" | "boxId">;

/** a message waiting in an outgoing box */
export interface Outgoing {
  frame: HeldFrame;
  /** the row whose log shows it on its way, and takes the sent placeholder when it goes */
  log: string;
}

/** the outbox's index entry: what the log draws a waiting message from without reading the box,
 * since the kinds are fixed for as long as it waits (a chip lost puts the whole message back) */
export interface OutboxEntry {
  id: string;
  log: string;
  kinds: AttachmentKind[];
}

const PREFIX = "out:";

/** An outgoing box's id: the tab that holds it and the box the message left. The tab, so that a
 * page coming back after a reload knows which waiting messages were its own and can put them back
 * where they were written, and leaves another tab's alone. The source, so a reply the daemon
 * addresses to this box (a message handed back unsent) finds its way to the composer. */
export const outBoxId = (clientId: string, seq: number, source: string): string =>
  `${PREFIX}${clientId}:${seq}:${source}`;

/** the tab and the source box an outgoing box id names, or null for any other box */
export function outBoxOf(id: string): { clientId: string; source: string } | null {
  if (!id.startsWith(PREFIX)) return null;
  const rest = id.slice(PREFIX.length);
  const tab = rest.indexOf(":");
  const seq = rest.indexOf(":", tab + 1);
  if (tab < 0 || seq < 0) return null;
  return { clientId: rest.slice(0, tab), source: rest.slice(seq + 1) };
}

/** the frame as it goes: the held one with the box's words and settled chips in it, from `boxId`.
 * The one place a message's frame is put together, held or not. */
export function fillFrame(
  frame: HeldFrame,
  boxId: string,
  text: string,
  items: readonly PendingAttachment[],
): ClientMsg {
  const attachments = items.length ? settledInputs(items) : undefined;
  switch (frame.t) {
    case "chat":
      return { ...frame, text, attachments, boxId };
    case "create-worktree":
      return { ...frame, prompt: text, attachments, boxId };
    case "restore-worktree":
    case "adopt-worktree":
      return { ...frame, message: { text, attachments }, boxId };
    case "agent-answer":
      return { ...frame, attachments, boxId };
  }
}

/** The outgoing boxes whose message can go now, in order: every upload it names has landed, and
 * nothing written before it for the same log is still waiting, since messages reach the agent in
 * the order they were sent. */
export function readyToGo(
  outbox: readonly OutboxEntry[],
  local: Readonly<Record<string, { attachments: readonly PendingAttachment[] } | undefined>>,
): string[] {
  const blocked = new Set<string>();
  const out: string[] = [];
  for (const entry of outbox) {
    if (blocked.has(entry.log)) continue;
    const box = local[entry.id];
    if (!box || box.attachments.some(isUploading)) {
      blocked.add(entry.log);
      continue;
    }
    out.push(entry.id);
  }
  return out;
}

/** the uploads a box's list names */
export const uploadsNamed = (items: readonly AttachmentInput[]): string[] =>
  items.flatMap((a) => ("upload" in a && a.upload ? [a.upload] : []));

/** Lists to tell the daemon, ordered so that no upload is unnamed in between: a list that names
 * an upload for the first time goes ahead of one that stops naming it. A message leaving its box
 * for an outgoing one, or going back, is one upload moving between two lists, and the daemon
 * deletes an upload the moment no list names it. */
export function namingFirst<T extends { items: AttachmentInput[]; before: readonly string[] }>(frames: T[]): T[] {
  const gains = (f: T) => uploadsNamed(f.items).some((id) => !f.before.includes(id));
  return [...frames.filter(gains), ...frames.filter((f) => !gains(f))];
}
