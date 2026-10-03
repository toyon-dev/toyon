import { fmtBytes } from "@toyon/shared";
import { pasteItems } from "../../state/actions/message.ts";
import { cx } from "../../ui/cx.ts";
import { Icon } from "../../ui/Icon.tsx";
import { AttachmentChip } from "./AttachmentChip.tsx";
import { FullPaste, PastePeek } from "./PasteChip.tsx";

/** An attached file, of any type. The agent reads it where the daemon stored it, so the chip says
 * what went: its name and its size. One that reads as text opens the way a paste does; anything
 * else is inert, since there is nothing here to draw it with. */
export function FileChip({
  name,
  bytes,
  href,
  uploading,
  onRemove,
  className = "",
}: {
  name: string;
  bytes: number;
  /** where its text is served from: set only for a file that reads as text and has landed */
  href?: string;
  /** its bytes are still on their way to the daemon */
  uploading?: boolean;
  onRemove?: () => void;
  className?: string;
}) {
  return (
    <AttachmentChip
      className={cx("file-chip", className)}
      label={
        <>
          <Icon name="file" className="icon-inline" />
          <span className="pick-target">
            <b>{name}</b>
            <span className="pick-file row-dim">
              {" "}
              · {fmtBytes(bytes)}
              {uploading && " · uploading"}
            </span>
          </span>
        </>
      }
      tip={name}
      peek={href ? <PastePeek href={href} /> : undefined}
      // read as what its name says it is: a markdown file rendered, a log or a script as its text
      full={href ? <FullPaste href={href} path={name} /> : undefined}
      menu={(ui) => pasteItems({ href }, ui)}
      removeLabel="Remove attachment"
      onRemove={onRemove}
    />
  );
}
