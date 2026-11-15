import { type ReactNode, type RefObject, useEffect, useState } from "react";
import { useTowardCentre } from "../../state/selectors.ts";
import { cx } from "../../ui/cx.ts";
import { Float } from "../../ui/Float.tsx";
import { handMoved, watchHand } from "../../ui/hand.ts";
import type { Placement, Rect } from "../../ui/place.ts";
import { createPeekHover } from "./peekHover.ts";

/** where the peek stands: beside the transcript rather than beside the chip. Level with the chip, and
 * off the transcript's edge onto the preview, so it covers nothing in the chat it was opened from.
 * The preview is on the far side from the dock the chat is in. Asking for one fixed side and leaving
 * the rest to the flip put a peek small enough to fit there over the rail, and a larger one over
 * the preview, so the same chip opened either way by what it held. */
const peekPlacement = (side: "left" | "right"): Placement => ({
  side,
  align: "center",
  offset: 12,
  flip: "side",
  margin: 8,
});

/**
 * What a chip stands for at a size you can read, up while the hand keeps the pointer on the chip
 * (peekHover.ts). A float rather than the chip grown in place: the transcript is a scroll box, so
 * anything grown inside it is clipped at its edge and covers the rows around it, and this one is a
 * chat's width wide.
 */
export function ChipPeek({
  chip: chipRef,
  className,
  children,
}: {
  chip: RefObject<HTMLDivElement | null>;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const side = useTowardCentre("chat");

  useEffect(() => {
    const chip = chipRef.current;
    if (!chip) return;
    watchHand();
    const at = (e: MouseEvent) => ({ x: e.clientX, y: e.clientY });
    const away = (e: MouseEvent) => hover.away(at(e));
    const press = () => hover.press();
    // a held peek has no chip under the pointer to hear from, so the document speaks for the hand
    const hold = (on: boolean) => {
      if (on) {
        document.addEventListener("mousemove", away, true);
        document.addEventListener("mousedown", press, true);
      } else {
        document.removeEventListener("mousemove", away, true);
        document.removeEventListener("mousedown", press, true);
      }
    };
    const hover = createPeekHover({ show: () => setOpen(true), hide: () => setOpen(false), hold });
    const enter = (e: MouseEvent) => hover.enter(at(e), handMoved(e));
    const move = (e: MouseEvent) => hover.move(at(e));
    const leave = (e: MouseEvent) => hover.leave(at(e), handMoved(e));
    chip.addEventListener("mouseenter", enter);
    chip.addEventListener("mousemove", move);
    chip.addEventListener("mouseleave", leave);
    // a press opens the whole thing at the window's size; the look at it has served
    chip.addEventListener("mousedown", press);
    return () => {
      // drops the timer and the document's listeners with it
      hover.press();
      chip.removeEventListener("mouseenter", enter);
      chip.removeEventListener("mousemove", move);
      chip.removeEventListener("mouseleave", leave);
      chip.removeEventListener("mousedown", press);
    };
  }, [chipRef]);

  // level with the chip, and as wide as the transcript around it, so "beside" means beside the
  // transcript. A chip outside one stands for itself.
  const anchor = (): Rect | null => {
    const chip = chipRef.current;
    if (!chip) return null;
    const row = chip.getBoundingClientRect();
    const log = chip.closest(".chat-log")?.getBoundingClientRect() ?? row;
    return { left: log.left, right: log.right, top: row.top, bottom: row.bottom };
  };

  if (!open) return null;
  return (
    // tracked: the transcript scrolls under the pointer and the peek goes with its chip, as far as
    // the window's edge once the chip is out of sight; and the box has its size only once what it
    // shows is in
    <Float className={cx("chip-peek", className)} anchor={anchor} placement={peekPlacement(side)} track>
      {children}
    </Float>
  );
}
