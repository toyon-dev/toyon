import { useDispatch, useStore } from "../../state/context.tsx";
import { IconButton } from "../../ui/Button.tsx";
import { paneInHand } from "../../ui/Pane.tsx";
import { chord } from "../util.ts";

/** The zen switch: lit while zen is on, and the way out of it by hand. It stands at the bar's far
 * edge, and at the end of the open file's head where zen has left no bar to hold it, so the same
 * control is in the same corner of the window either way. */
export function ZenToggle({ className }: { className?: string }) {
  const dispatch = useDispatch();
  const on = useStore((s) => s.zen);
  return (
    <IconButton
      icon="zen"
      className={className}
      label="Full-bleed preview"
      hint={chord("zen")}
      tone="chrome"
      on={on}
      // hung from its outer edge: centred, the tip's box would run into the window's edge
      tipAlign="end"
      onClick={() => dispatch({ a: "toggle-zen", file: paneInHand("editor") })}
    />
  );
}
