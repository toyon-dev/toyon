import type { ReactNode } from "react";
import { IconButton } from "../../ui/Button.tsx";
import { Float } from "../../ui/Float.tsx";
import { type MenuEntry, useContextMenu } from "../../ui/menu.ts";

/**
 * What an attachment chip holds, at the window's size, over everything: the image, a paste's text.
 *
 * Shown here rather than opened as a tab, because the installed app has no browser chrome: a window
 * navigated to the daemon's copy has no address bar, no back and no Escape, and nothing left on the
 * page leads to the shell. Escape, the close button, or a press beside the thing takes it down.
 *
 * `menu` is the chip's own, offered anywhere in this view: the float is drawn inside the chip's
 * message row, so without one a right-click here would open the row's menu about a message.
 */
export function FullAttachment({
  onClose,
  menu,
  children,
}: {
  onClose: () => void;
  menu?: () => MenuEntry[];
  children: ReactNode;
}) {
  const cm = useContextMenu("chat");
  return (
    <Float
      className="attach-full"
      onDismiss={onClose}
      onKey={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        onClose();
      }}
      // the scrim is the box itself, so a press beside the picture is inside this float and the
      // stack hears no outside press; the box closes on its own
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      {...(menu && cm.contextMenu(menu))}
    >
      {children}
      <IconButton icon="close" label="Close" tone="quiet" onClick={onClose} />
    </Float>
  );
}
