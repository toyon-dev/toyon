import { attachmentLabel, type ImageRef } from "@toyon/shared";
import { imageItems } from "../../state/actions/message.ts";
import { cx } from "../../ui/cx.ts";
import { AttachmentChip } from "./AttachmentChip.tsx";
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
            </span>
          </span>
        </>
      }
      // the ratio holds the peek's shape until the image is in
      peek={<img src={src} alt={name} style={{ aspectRatio: `${width} / ${height}` }} />}
      full={<img src={src} alt={name} />}
      menu={(ui) => imageItems(src, ui)}
      removeLabel="Remove image"
      onRemove={onRemove}
    />
  );
}

/** the chip for an image that has been sent: the daemon serves it back by worktree + file */
export function SentImageChip({ img, src }: { img: ImageRef; src: string }) {
  return <ImageChip className="in-chat" src={src} {...img} />;
}
