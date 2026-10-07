import type { AgentLimits } from "@toyon/shared";
import type { CSSProperties } from "react";
import type { UsageFigures } from "../../state/store.ts";
import { Float } from "../../ui/Float.tsx";
import type { Placement } from "../../ui/place.ts";
import { spanWords } from "../util.ts";
import { dollars, limitRows, tokens } from "./usage.ts";

/** above the ring at the foot of the box, turning over only when the window is too short */
const PLACEMENT: Placement = { side: "top", align: "start", offset: 6, flip: "both", margin: 8 };

/** a reading older than this says so: the windows are the account's, read off replies, and a new
 * worktree may be looking at figures another worktree heard a while ago */
const STALE_MS = 5 * 60_000;

/**
 * The figures behind the ring, a bar each: this worktree's context, then the account's plan
 * windows, with when each one resets under it. This is the ring's hover, in place of a tooltip,
 * so the reset times are a glance away. A click pins it and adds the one press the figures lead
 * to, compacting, at the foot behind a rule; a press outside, or Escape, closes it. Anchored to
 * the ring's wrapper.
 */
export function UsagePanel({
  usage,
  limits,
  now,
  compact,
  onClose,
}: {
  usage: UsageFigures | undefined;
  limits: AgentLimits | undefined;
  now: number;
  /** the compact row, once the panel is pinned: why it is off, else the advice under it, and
   * what the press does. Absent while the panel is only being looked at. */
  compact?: { off?: string; advice?: string; run: () => void };
  onClose: () => void;
}) {
  const rows = limits ? limitRows(limits, now) : [];
  const stale = limits && now - limits.at > STALE_MS ? spanWords(now - limits.at) : null;
  const cost = usage?.cost !== undefined ? ` · ${dollars(usage.cost)}` : "";
  return (
    <Float
      className="usage-panel"
      anchor="parent"
      placement={PLACEMENT}
      onDismiss={onClose}
      onKey={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      {usage && (
        <Meter
          name="context"
          used={usage.used / usage.size}
          sub={`${tokens(usage.used)} of ${tokens(usage.size)}${cost}`}
        />
      )}
      {rows.map((r) => (
        <Meter key={r.key} name={r.name} used={r.used} sub={r.sub} />
      ))}
      {stale && <div className="usage-stale hint">read {stale} ago</div>}
      {compact && (
        <>
          <hr className="usage-rule" />
          <button type="button" className="row usage-compact" disabled={!!compact.off} onClick={compact.run}>
            <span>compact the context</span>
            <span className="usage-detail hint">{compact.off ?? compact.advice}</span>
          </button>
        </>
      )}
    </Float>
  );
}

function Meter({ name, used, sub }: { name: string; used: number; sub: string }) {
  const fill = Math.max(0, Math.min(1, used));
  return (
    <>
      <div className="usage-row">
        <span className="usage-name">{name}</span>
        <span className="meter">
          <span className="meter-fill" style={{ "--meter": fill } as CSSProperties} />
        </span>
        <span className="usage-fig">{Math.round(100 * used)}%</span>
      </div>
      <div className="usage-sub hint">{sub}</div>
    </>
  );
}
