// The card that takes the message box when the agent's turn is stopped on the person: a question,
// a permission, a list of pieces. The keyboard is already there, the box never scrolls away, and it is
// where a reply is written anyway. A card is a head (the sentence asked), a band to read before
// answering (a command, a plan, a preview), the numbered choices (`ui/Choices`), and a foot of
// actions; this is the frame they share.
//
// The root is the focused element and reads its own keys (`ui/choiceKeys`), and every key has a
// row or a button behind it: the digit and the click run the same handler, so nothing here is
// keyboard-only. Escape parks the card and gives the plain box back; the card stays open, since it
// is still what the agent waits on.

import { type ReactNode, type RefObject, useCallback, useEffect, useRef } from "react";
import { useOnChange } from "../../ui/hooks.ts";
import { useCodeCopy } from "./useCodeCopy.tsx";

export type Root = RefObject<HTMLDivElement>;

/** an element that is keeping the keyboard for good reason: an editor, a terminal, a field
 * elsewhere. The box's own textarea and a row in the transcript or the rail are not. */
function holdsKeyboard(el: Element | null): boolean {
  if (!el || el === document.body) return false;
  if (el.closest(".monaco-editor, .xterm")) return true;
  return (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && !el.closest(".chat-input");
}

/** The root takes the keyboard as it mounts (the card arriving, or coming back from parked),
 * because nothing else in the worktree is useful while the agent is blocked, unless a hand is
 * somewhere that plainly wants it. And it takes it back when a click dropped it nowhere: a click
 * on the transcript's text, to read or to scroll, lands focus on the body, and from there every
 * digit went dead with nothing on screen saying so. A click that lands somewhere (a row, a field,
 * the preview) keeps what it landed on. It waits for the press to be let go: focus moving under a
 * held button ends the drag, so a selection begun in the transcript never got past its first
 * character. */
function useCardFocus(root: Root, id: string) {
  useOnChange([id], () => {
    // rAF because the root is painted in the same commit that mounts it
    const f = requestAnimationFrame(() => {
      if (!holdsKeyboard(document.activeElement)) root.current?.focus();
    });
    return () => cancelAnimationFrame(f);
  });
  const pressed = useRef(false);
  // the body is only known after the event: a click into the preview reports no target either,
  // and the iframe is what holds focus by the next frame
  const retake = useCallback(() => {
    requestAnimationFrame(() => {
      if (document.activeElement === document.body) root.current?.focus();
    });
  }, [root]);
  useEffect(() => {
    const onDown = () => {
      pressed.current = true;
    };
    const onUp = () => {
      pressed.current = false;
      retake();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    // a drag the browser took over (selected text picked up and carried) ends without a release
    window.addEventListener("pointercancel", onUp, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
    };
  }, [retake]);
  return (e: React.FocusEvent) => {
    // the release answers for a press; this is for focus dropped nowhere by anything else
    if (!e.relatedTarget && !pressed.current) retake();
  };
}

/** The pointer is over a row: the row shows what its digit, enter and `n` would do, so the next
 * key is read against it. A transcript row pressed to read keeps the keyboard after the release
 * (it reads Escape and the arrows), and from there `n` on the option under the pointer did nothing
 * but draw that row's ring. Not taken from a field of the card's own, where a note is being typed
 * as the pointer drifts across the rows, nor from a hand that plainly wants the keyboard. */
export function takeKeyboard(root: Root) {
  const at = document.activeElement;
  if (holdsKeyboard(at) || (at && root.current?.contains(at))) return;
  root.current?.focus({ preventScroll: true });
}

export function Card({
  root,
  id,
  onKeyDown,
  onKeyUp,
  onPaste,
  children,
}: {
  root: Root;
  /** the card's own id: a new one takes the keyboard */
  id: string;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onKeyUp?: (e: React.KeyboardEvent) => void;
  /** a card that takes what is pasted on it, the way the composer's field does */
  onPaste?: (e: React.ClipboardEvent) => void;
  children: ReactNode;
}) {
  const onBlur = useCardFocus(root, id);
  return (
    <div
      ref={root}
      className="card"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onPaste={onPaste}
      onBlur={onBlur}
    >
      {children}
    </div>
  );
}

/** the sentence the card asks, and under it what the person should know before answering */
export function CardHead({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="card-head">
      <div className="card-text">{children}</div>
      {sub && <div className="card-sub">{sub}</div>}
    </div>
  );
}

/** What stands under the sentence to be read before it is answered: the command a yes would run,
 * a plan with no file behind it. Set in code the band's text is the block and gets the copy
 * control, since someone saying no often runs the command themselves; rendered markdown keeps its
 * own fenced blocks, each with the control. An option's sample is not a band: it stands with its
 * row (ui/Choices). */
export function CardBand(props: { code: string } | { html: string }) {
  const band = useRef<HTMLDivElement>(null);
  const copy = useCodeCopy(band);
  if ("html" in props)
    return (
      // the markup goes into a child of the band so the band keeps a child of its own beside it
      <div ref={band} className="card-band md">
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: html is DOMPurify-sanitized markdown */}
        <div dangerouslySetInnerHTML={{ __html: props.html }} />
        {copy}
      </div>
    );
  return (
    <div ref={band} className="card-band card-code">
      <pre>{props.code}</pre>
      {copy}
    </div>
  );
}

/** the actions under the choices, at the card's floor */
export function CardFoot({ children }: { children: ReactNode }) {
  return <div className="card-foot">{children}</div>;
}
