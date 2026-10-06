// The keyboard of a numbered list in a card that holds the keyboard: a digit picks its row, the
// arrows walk the cursor, enter picks the cursor's row, ⌘⏎ is the card's send and escape gives the
// box back. A field open on a row reads its own keys: enter is the row's answer, ⌘⏎ the send,
// escape and tab the way back to the rows, and everything else is typing. The reading is pure over
// the event's shape, so each card's keyboard is tested without a DOM; `handleChoiceKey` is the
// React handler over it, and a card runs it before its own keys.

import { step } from "./listNav.ts";

export type KeyLike = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey?: boolean };

/** a key the shell owns while the card holds the keyboard: ⌘1-9 switches the chat, ⌥↑/↓ walks
 * the rail, and both reach the card first. The card reads only the bare key, or ⌘1 pressed to
 * leave would pick option 1 and, on a one-question card, send it. ⌘⏎ is the card's own send. */
export function shellChord(e: KeyLike): boolean {
  if (isEnter(e.key) && (e.metaKey || e.ctrlKey) && !e.altKey) return false;
  return e.metaKey || e.ctrlKey || e.altKey;
}

export const isDigit = (key: string) => key.length === 1 && key >= "1" && key <= "9";
export const isEnter = (key: string) => key === "Enter" || key === "NumpadEnter";

export type ChoiceList = {
  /** rows a digit can reach */
  count: number;
  /** the row the keyboard is on; a list with none has nothing for enter to pick, so enter is
   * the send, and the arrows walk nothing */
  cursor?: number;
  /** space picks the cursor's row too: a multi-select's toggle */
  spacePicks?: boolean;
};

export type ChoiceKey =
  /** the shell's chord: leave it be */
  | { kind: "chord" }
  | { kind: "escape" }
  | { kind: "submit" }
  | { kind: "pick"; at: number; by: "digit" | "enter" }
  | { kind: "cursor"; to: number }
  | { kind: "field-enter" }
  | { kind: "field-leave" }
  /** a key the field itself reads; the card has nothing to do with it */
  | { kind: "typing" };

export function choiceKey(e: KeyLike, inField: boolean, list: ChoiceList): ChoiceKey | null {
  const send = isEnter(e.key) && (e.metaKey || e.ctrlKey);
  if (inField) {
    if (e.key === "Escape" || (e.key === "Tab" && !e.shiftKey)) return { kind: "field-leave" };
    if (send) return { kind: "submit" };
    if (isEnter(e.key) && !e.shiftKey) return { kind: "field-enter" };
    return { kind: "typing" };
  }
  if (shellChord(e)) return { kind: "chord" };
  if (e.key === "Escape") return { kind: "escape" };
  if (send) return { kind: "submit" };
  if (isEnter(e.key) || (e.key === " " && list.spacePicks)) {
    return list.cursor === undefined ? { kind: "submit" } : { kind: "pick", at: list.cursor, by: "enter" };
  }
  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    if (list.cursor === undefined) return null;
    return { kind: "cursor", to: step(list.cursor, e.key === "ArrowUp" ? -1 : 1, list.count) };
  }
  if (isDigit(e.key) && Number(e.key) <= list.count) return { kind: "pick", at: Number(e.key) - 1, by: "digit" };
  return null;
}

export type ChoiceKeyHandlers = ChoiceList & {
  onCursor?: (to: number) => void;
  onPick: (at: number, by: "digit" | "enter") => void;
  /** the card's send: ⌘⏎ anywhere, and plain enter on a list with no cursor. A card with no send
   * of its own (a permission, a handoff) reads ⌘⏎ as enter. */
  onSubmit?: () => void;
  onEscape: () => void;
  onFieldEnter?: () => void;
  onFieldLeave?: () => void;
};

/** the list's keys on a card's root: true when the key was the list's (or the field's, or the
 * shell's) and the card's own keys should not read it */
export function handleChoiceKey(e: React.KeyboardEvent, h: ChoiceKeyHandlers): boolean {
  const inField = e.target instanceof HTMLTextAreaElement;
  const hit = choiceKey(e, inField, h);
  if (!hit) return false;
  switch (hit.kind) {
    case "chord":
    case "typing":
      return true;
    case "escape":
    case "field-leave":
      // the app-wide esc would close a pane or stop the turn
      e.preventDefault();
      e.stopPropagation();
      (hit.kind === "escape" ? h.onEscape : h.onFieldLeave)?.();
      return true;
    case "submit":
      e.preventDefault();
      if (h.onSubmit) h.onSubmit();
      else if (inField) h.onFieldEnter?.();
      else if (h.cursor !== undefined) h.onPick(h.cursor, "enter");
      return true;
    case "pick":
      // a button the mouse just focused would press itself on enter too
      e.preventDefault();
      h.onPick(hit.at, hit.by);
      return true;
    case "cursor":
      e.preventDefault();
      h.onCursor?.(hit.to);
      return true;
    case "field-enter":
      e.preventDefault();
      h.onFieldEnter?.();
      return true;
  }
}
