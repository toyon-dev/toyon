import type { ReactNode } from "react";
import { useStoreInstance } from "../state/context.tsx";
import { isSubPicker } from "../state/store.ts";
import { cx } from "./cx.ts";
import { Float } from "./Float.tsx";
import "./overlay.css";
import type { Flip } from "./place.ts";

/** How an anchored box sits on the control it belongs to, where that differs from the default: it
 * opens over the control, growing down from its top edge, and lines up on its left. `matchWidth`
 * takes the control's width (the route list is the address field's own box), and `flip` lets it
 * turn over or swap ends when the window has no room that way. */
export type Anchored = { flip?: Flip; margin?: number; matchWidth?: number };

type Props = {
  /** absent = the box can't be dismissed (first-run config must be confirmed) */
  onClose?: () => void;
  /** Escape while this is the topmost float, for a box the store does not own. One it does own
   * leaves this alone and is closed through the store, back to the palette it came from. */
  onEscape?: () => void;
  boxClass?: string;
  /** no box chrome: the children bring their own cards (shortcuts + settings) */
  bare?: boolean;
  /** a dropdown on the control that opened it, rather than a centred overlay over the window */
  anchored?: boolean | Anchored;
  /** the part of the box that lands on the control: the panel's own field, so the value it holds
   * does not move when the panel opens over it */
  coverBy?: string;
  /** names the box for the control that says it opens this one (`aria-controls`) */
  id?: string;
  children: ReactNode;
};

/**
 * The palette frame: a scrim over the window and a box, or a dropdown on the control that
 * opened it. Every overlay dismisses the same way, through the one stack in floats.ts: a press
 * outside it and everything it opened, or a press in the preview, which never reaches this page.
 */
export function Overlay({ anchored = false, ...rest }: Props) {
  return anchored ? <Dropdown {...rest} anchored={anchored === true ? {} : anchored} /> : <Centred {...rest} />;
}

function Dropdown({
  onClose,
  onEscape,
  boxClass = "",
  bare = false,
  anchored,
  coverBy,
  id,
  children,
}: Omit<Props, "anchored"> & { anchored: Anchored }) {
  const { onKey, back } = useEscape(onEscape);
  return (
    <Float
      className={cx(bare ? "" : "overlay-box", "anchored", boxClass)}
      id={id}
      anchor="parent"
      placement={{ side: "bottom", align: "start", cover: true, margin: 0, ...anchored }}
      coverBy={coverBy}
      onDismiss={onClose ? () => onClose() : undefined}
      onKey={onKey}
      onBack={() => back() || onClose?.()}
    >
      {children}
    </Float>
  );
}

/**
 * The box is about the app, not the preview: a palette, the settings, a project's page. So it is
 * measured against the window, the same box in every layout, and not against whatever the docks
 * leave of the centre, where a narrow column wrapped every shortcut's label. The scrim is the
 * float's own box, as a top-layer box has nothing above it to dim it with; a press on it is inside
 * the float for the stack, which keeps the palette and closes what it opened, and the box then
 * closes itself. The id sits on the float for the same reason: the stack reads `aria-controls`
 * against the box it holds.
 */
function Centred({ onClose, onEscape, boxClass = "", bare = false, id, children }: Omit<Props, "anchored">) {
  const { onKey, back } = useEscape(onEscape);
  return (
    <Float
      className="overlay scrim"
      id={id}
      onDismiss={onClose ? () => onClose() : undefined}
      onKey={onKey}
      onBack={() => back() || onClose?.()}
      onClick={(e) => {
        if (onClose && e.target === e.currentTarget) onClose();
      }}
    >
      <div className={cx(bare ? "" : "overlay-box", boxClass)}>{children}</div>
    </Float>
  );
}

/**
 * The stack hands the topmost float every key before whatever holds the caret hears it; a box
 * answers Escape and ends that one alone. That order is the point: a box with nothing to type in
 * leaves the caret where it was (a terminal, an open row in the chat, a find field), and each of
 * those answers Escape for itself. A box the store owns closes through the store, and a sub-picker
 * goes back to the palette it came from. `back` is that answer without the key, for the phone's
 * swipe, and says whether there was anything of the box's to close.
 */
function useEscape(onEscape?: () => void) {
  const store = useStoreInstance();
  const back = (): boolean => {
    if (onEscape) {
      onEscape();
      return true;
    }
    const s = store.getState();
    // the Finder dialog is above every box, and its Escape is taken in app/keys.ts
    if (!s.overlay || s.choosingFolder) return false;
    store.dispatch({ a: "close", back: isSubPicker(s.overlay) });
    return true;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && back()) e.stopPropagation();
  };
  return { onKey, back };
}
