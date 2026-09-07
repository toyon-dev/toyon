import type { ImageRef } from "@toyon/shared";
import { fmtBytes } from "./images.ts";

/** an attached image as a chip: thumbnail, its session number, name and size. In the composer it
 * can be removed; in the chat it links to the full image. Same row shape as PickChip so the two
 * stack above the textarea. */
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
        <b>Image {n}</b>
        <span className="pick-file">
          {" "}
          · {name} · {width}×{height} · {fmtBytes(bytes)}
        </span>
      </span>
    </>
  );
  return (
    <div className={`pick-chip image-chip ${className}`} data-tip={onRemove ? undefined : "Open full size"}>
      {onRemove ? (
        body
      ) : (
        <a className="image-link" href={src} target="_blank" rel="noreferrer">
          {body}
        </a>
      )}
      {onRemove && (
        <button data-tip="Remove image" aria-label="Remove image" onClick={onRemove}>
          ✕
        </button>
      )}
    </div>
  );
}

/** the chip for an image that has been sent: the daemon serves it back by worktree + file */
export function SentImageChip({ img, src }: { img: ImageRef; src: string }) {
  return <ImageChip className="in-chat" src={src} {...img} />;
}
