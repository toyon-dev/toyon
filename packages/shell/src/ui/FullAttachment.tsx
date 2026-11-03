import { type ReactNode, useRef } from "react";
import { IconButton } from "./Button.tsx";
import { Float } from "./Float.tsx";
import { useFullGestures } from "./fullGestures.ts";
import { navStep } from "./fullNav.ts";
import { type MenuEntry, useContextMenu } from "./menu.ts";
import "./full-attachment.css";

/** the view's way along the list it was opened from: where it stands, how many stops there are,
 * and the step the arrow keys take. Absent for a view of one thing (a call's picture, a file). */
export type FullNav = { at: number; of: number; step: (dir: -1 | 1) => void };

/**
 * What a chip or a pane holds, at the window's size, over everything: the image, a paste's text.
 *
 * Shown here rather than opened as a tab, because the installed app has no browser chrome: a window
 * navigated to the daemon's copy has no address bar, no back and no Escape, and nothing left on the
 * page leads to the shell. Escape, the close button, or a press beside the thing takes it down. A
 * picture goes under a finger as well, tapped or swiped up or down: on a phone it fills the window
 * and leaves nothing beside it to press. Pinched or double-tapped it zooms, and zoomed it pans
 * (fullGestures.ts).
 *
 * Opened from a list (a message's attachments), the left and right arrows step to the neighbours
 * and the head says where in the list this is. One of one says nothing: there is nowhere to go.
 *
 * `menu` is the opener's own, offered anywhere in this view: the float is drawn inside the opener's
 * row, so without one a right-click here would open the row's menu about a message. `owner` names
 * the surface that opened it, the way its other menus do.
 */
export function FullAttachment({
  owner,
  onClose,
  menu,
  nav,
  children,
}: {
  owner: string;
  onClose: () => void;
  menu?: () => MenuEntry[];
  nav?: FullNav;
  children: ReactNode;
}) {
  const cm = useContextMenu(owner);
  const box = useRef<HTMLDivElement | null>(null);
  useFullGestures(box, "img", onClose);
  return (
    <Float
      className="attach-full scrim"
      boxRef={box}
      onDismiss={onClose}
      onKey={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
          return;
        }
        const dir = nav && navStep(e);
        if (!dir) return;
        // the key is the view's: a paste's box under it would scroll, and the rows and the rail
        // behind it fold and switch on the same arrows
        e.preventDefault();
        e.stopPropagation();
        nav.step(dir);
      }}
      // the scrim is the box itself, so a press beside the picture is inside this float and the
      // stack hears no outside press; the box closes on its own
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      {...(menu && cm.contextMenu(menu))}
    >
      {children}
      <div className="attach-head">
        {nav && nav.of > 1 && (
          <span className="attach-count">
            {nav.at + 1} of {nav.of}
          </span>
        )}
        <IconButton icon="close" label="Close" tone="quiet" onClick={onClose} />
      </div>
    </Float>
  );
}
