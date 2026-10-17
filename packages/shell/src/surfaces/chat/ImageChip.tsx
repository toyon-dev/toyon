import { attachmentLabel, fmtBytes, type ImageRef } from "@toyon/shared";
import { imageItems } from "../../state/actions/message.ts";
import { useSock } from "../../state/context.tsx";
import { cx } from "../../ui/cx.ts";
import { AttachmentChip } from "./AttachmentChip.tsx";

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
  kept,
  uploading,
  progress,
  onRemove,
  className = "",
}: {
  src: string;
  n: number;
  name: string;
  width: number;
  height: number;
  bytes: number;
  /** the daemon's copy, once the message has gone: what the menu reveals and names */
  kept?: { worktreeId: string; file: string };
  /** its bytes are still on their way to the daemon */
  uploading?: boolean;
  /** how much of them has gone, in whole percent, once the browser has said */
  progress?: number;
  onRemove?: () => void;
  className?: string;
}) {
  const sock = useSock();
  return (
    <AttachmentChip
      className={cx("image-chip", className)}
      label={
        <>
          <img className="image-thumb" src={src} alt={name} width={40} height={40} />
          <span className="pick-target">
            <b>{attachmentLabel("image", n)}</b>
            <span className="pick-file row-dim">
              {" "}
              · {name} · {width}×{height} · {fmtBytes(bytes)}
              {progress !== undefined ? (
                <>
                  {" "}
                  · <span className="pick-progress">{progress}%</span>
                </>
              ) : (
                uploading && " · uploading"
              )}
            </span>
          </span>
        </>
      }
      // the ratio holds the peek's shape until the image is in
      peek={<img src={src} alt={name} style={{ aspectRatio: `${width} / ${height}` }} />}
      full={<img src={src} alt={name} />}
      menu={(ui) => imageItems(src, ui, kept && { ...kept, sock })}
      removeLabel="Remove image"
      onRemove={onRemove}
    />
  );
}

/** the chip for an image that has been sent: the daemon serves it back by worktree + file, and
 * keeps the copy the menu can reveal */
export function SentImageChip({ img, worktreeId, src }: { img: ImageRef; worktreeId: string; src: string }) {
  return <ImageChip className="in-chat" src={src} {...img} kept={{ worktreeId, file: img.file }} />;
}
