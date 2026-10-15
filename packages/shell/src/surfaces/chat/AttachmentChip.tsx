import { type ReactNode, useRef } from "react";
import type { ChipUi } from "../../state/actions/message.ts";
import { IconButton } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { FullAttachment } from "../../ui/FullAttachment.tsx";
import { type MenuEntry, useContextMenu } from "../../ui/menu.ts";
import { useAttachmentSlot } from "./AttachmentSet.tsx";
import { ChipPeek } from "./ChipPeek.tsx";

/**
 * The frame an attachment that holds something to read shares: a row that opens what it holds at
 * the window's size when pressed, shows it beside the transcript while hovered, and carries its
 * menu. The image and the paste fill it with their own label, peek and full view. A chip with no
 * `full` has nothing to open: its label is inert and it shows no peek.
 *
 * Which chip is open is the list's (AttachmentSet), so the full view can step to the chips beside
 * this one; the view itself is drawn here, with what the chip shows now.
 */
export function AttachmentChip({
  className,
  label,
  tip,
  peek,
  full,
  menu,
  removeLabel,
  onRemove,
}: {
  className?: string;
  label: ReactNode;
  /** what the hover says when there is nothing to open */
  tip?: string;
  peek?: ReactNode;
  full?: ReactNode;
  /** its menu, on the chip (which can open and remove it) and inside the full view (which cannot) */
  menu: (ui?: ChipUi) => MenuEntry[];
  removeLabel: string;
  onRemove?: () => void;
}) {
  const chip = useRef<HTMLDivElement | null>(null);
  const cm = useContextMenu("chat");
  const canOpen = full !== undefined;
  const slot = useAttachmentSlot(chip, canOpen);
  return (
    // the tip trails the pointer: centred under a row this wide it lands on the row below
    <div
      ref={chip}
      className={cx("pick-chip row row-sm", className)}
      data-tip={canOpen ? "Open full size" : tip}
      data-tip-placement="follow"
      {...cm.contextMenu(() => menu({ open: canOpen ? slot.show : undefined, remove: onRemove }))}
    >
      {canOpen ? (
        <button type="button" className="chip-link" onClick={slot.show}>
          {label}
        </button>
      ) : (
        label
      )}
      {onRemove && <IconButton icon="close" label={removeLabel} tone="quiet" onClick={onRemove} />}
      {canOpen && peek !== undefined && <ChipPeek chip={chip}>{peek}</ChipPeek>}
      {slot.open && canOpen && (
        <FullAttachment owner="chat" onClose={slot.close} menu={() => menu()} nav={slot.nav}>
          {full}
        </FullAttachment>
      )}
    </div>
  );
}
