import { attachmentLabel, type ImageRef } from "@toyon/shared";
import { type RefObject, useEffect, useRef, useState } from "react";
import { IconButton } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { Float } from "../../ui/Float.tsx";
import type { Placement, Rect } from "../../ui/place.ts";
import { fmtBytes } from "./images.ts";

/** an attached image as a chip: thumbnail, its session number, name and size. In the composer it
 * can be removed; in the chat it links to the full image and shows a larger look while hovered.
 * Same row shape as PickChip so the two stack above the textarea. */
export function ImageChip({
  src,
  n,
  name,
  width,
  height,
  bytes,
  onRemove,
  className = "",
}: {
  src: string;
  n: number;
  name: string;
  width: number;
  height: number;
  bytes: number;
  onRemove?: () => void;
  className?: string;
}) {
  const body = (
    <>
      <img className="image-thumb" src={src} alt={name} width={40} height={40} />
      <span className="pick-target">
        <b>{attachmentLabel("image", n)}</b>
        <span className="pick-file">
          {" "}
          · {name} · {width}×{height} · {fmtBytes(bytes)}
        </span>
      </span>
    </>
  );
  const chip = useRef<HTMLDivElement | null>(null);
  if (onRemove) {
    return (
      <div className={cx("pick-chip image-chip", className)}>
        {body}
        <IconButton icon="close" label="Remove image" tone="quiet" onClick={onRemove} />
      </div>
    );
  }
  return (
    // the tip trails the pointer: centred under a row this wide it lands on the row below
    <div
      ref={chip}
      className={cx("pick-chip image-chip", className)}
      data-tip="Open full size"
      data-tip-placement="follow"
    >
      <a className="image-link" href={src} target="_blank" rel="noreferrer">
        {body}
      </a>
      <ImagePeek chip={chip} src={src} alt={name} width={width} height={height} />
    </div>
  );
}

/** the chip for an image that has been sent: the daemon serves it back by worktree + file */
export function SentImageChip({ img, src }: { img: ImageRef; src: string }) {
  return <ImageChip className="in-chat" src={src} {...img} />;
}

/** a sweep across the chips should not flash each image up; the same wait a tooltip takes */
const PEEK_DELAY = 150;

/** where the peek stands: beside the transcript rather than beside the chip. Level with the chip, and
 * off the transcript's edge onto the preview, so it covers nothing in the chat it was opened from. */
const PEEK_PLACEMENT: Placement = { side: "left", align: "center", offset: 12, flip: "side", margin: 8 };

/**
 * The image at a size you can read, up while the chip is under the pointer. A float rather than the
 * thumb scaled in place: the transcript is a scroll box, so anything grown inside it is clipped at
 * its edge and covers the rows around it, and this one is a chat's width wide.
 */
function ImagePeek({
  chip: chipRef,
  src,
  alt,
  width,
  height,
}: {
  chip: RefObject<HTMLDivElement | null>;
  src: string;
  alt: string;
  width: number;
  height: number;
}) {
  const [open, setOpen] = useState(false);

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
    // a press opens the full image in a tab; the look at it has served
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
    // tracked: the transcript scrolls under the pointer, and the box has its size only once the
    // image is in; the ratio holds its shape until then
    <Float className="image-peek" anchor={anchor} placement={PEEK_PLACEMENT} track>
      <img src={src} alt={alt} style={{ aspectRatio: `${width} / ${height}` }} />
    </Float>
  );
}
