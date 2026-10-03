import { type ReactNode, type RefObject, useEffect, useState } from "react";
import { useStore } from "../../state/context.tsx";
import { cx } from "../../ui/cx.ts";
import { Float } from "../../ui/Float.tsx";
import type { Placement, Rect } from "../../ui/place.ts";

/** a sweep across the chips should not flash each one up; the same wait a tooltip takes */
const PEEK_DELAY = 150;

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
 * What a chip stands for at a size you can read, up while the chip is under the pointer. A float
 * rather than the chip grown in place: the transcript is a scroll box, so anything grown inside it
 * is clipped at its edge and covers the rows around it, and this one is a chat's width wide.
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
  const chatSide = useStore((s) => s.chatSide);

  useEffect(() => {
    const chip = chipRef.current;
    if (!chip) return;
    let timer = 0;
    const hide = () => {
      window.clearTimeout(timer);
      setOpen(false);
    };
    const enter = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setOpen(true), PEEK_DELAY);
    };
    chip.addEventListener("mouseenter", enter);
    chip.addEventListener("mouseleave", hide);
    // a press opens the whole thing at the window's size; the look at it has served
    chip.addEventListener("mousedown", hide);
    return () => {
      window.clearTimeout(timer);
      chip.removeEventListener("mouseenter", enter);
      chip.removeEventListener("mouseleave", hide);
      chip.removeEventListener("mousedown", hide);
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
    // tracked: the transcript scrolls under the pointer, and the box has its size only once what
    // it shows is in
    <Float
      className={cx("chip-peek", className)}
      anchor={anchor}
      placement={peekPlacement(chatSide === "left" ? "right" : "left")}
      track
    >
      {children}
    </Float>
  );
}
