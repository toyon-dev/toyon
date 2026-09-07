import { useStore } from "../../state/context.tsx";
import { useActive } from "../../state/selectors.ts";
import { ChatLog } from "./ChatLog.tsx";
import { Composer } from "./Composer.tsx";
import { useImageIntake } from "./useImageIntake.ts";

/** the chat panel: transcript above, composer below */
export function RightDock({ width }: { width: number }) {
  const rightOpen = useStore((s) => s.rightOpen);
  const active = useActive();
  // a screenshot dropped anywhere on the chat panel attaches to the composer
  const { over, onDragOver, onDragLeave, onDrop } = useImageIntake(active?.worktree.id ?? null);
  return (
    <div
      className={`right-dock ${rightOpen ? "" : "collapsed"} ${over ? "drop-over" : ""}`}
      style={{ width }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <ChatLog active={active} />
      <Composer active={active} />
    </div>
  );
}
