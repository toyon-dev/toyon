import { type ArchivedWorktree, type ChatHit, type OwnedWorktree, queryTerms } from "@toyon/shared";
import { archivedHint } from "../../state/actions/archive.ts";

/** what the palette looks through: the chats' names and what they say, or their names alone */
export type ChatScope = "all" | "names";

/** a chat by its name: listed before anything is typed, and above the hits once something is, since
 * typing a branch's name finds its chat though nothing in the chat says it */
export type ChatRow = {
  kind: "chat";
  id: string;
  name: string;
  hint: string;
  fields: string[];
  /** the first message sent. Matched only when names are all that is searched: with the messages
   * searched too it is a hit already, and the same words twice would put the row that opens no
   * message above the one that does. */
  prompt?: string;
  /** the record of one that was removed: its page, its menu, and whether it can come back */
  archived?: ArchivedWorktree;
};
export type ChatsRow = ChatRow | { kind: "hit"; hit: ChatHit };

/** a query this short matches nearly every message, and the daemon answers nothing under it */
const MIN = 2;
/** measured as the daemon measures it: what is searched for, not the quotes around it */
export const tooShort = (q: string) => queryTerms(q).join(" ").length < MIN;

export const liveRow = (w: OwnedWorktree): ChatRow => ({
  kind: "chat",
  id: w.id,
  name: w.name,
  hint: w.branch ?? "",
  fields: [w.name, w.branch ?? ""],
});

export const archivedRow = (a: ArchivedWorktree): ChatRow => ({
  kind: "chat",
  id: a.id,
  name: a.title,
  hint: archivedHint(a),
  fields: [a.title, a.branch],
  prompt: a.prompt,
  archived: a,
});

/** The rows for a query. The hits are the daemon's answer, shown as they came, and only for a query
 * it would answer; the chats are matched here by the daemon's rule: every term somewhere in the
 * name or the branch, a quoted phrase whole. Nothing typed lists every chat. */
export function chatRows(rows: ChatsRow[], q: string, scope: ChatScope): ChatsRow[] {
  const terms = queryTerms(q);
  const hits = scope === "all" && !tooShort(q);
  return rows.filter((r) => {
    if (r.kind === "hit") return hits;
    const fields = scope === "names" && r.prompt ? [...r.fields, r.prompt] : r.fields;
    return terms.every((t) => fields.some((f) => f.toLowerCase().includes(t)));
  });
}
