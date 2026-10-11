import type { TailnetDevice } from "@toyon/shared";
import type { ReactNode } from "react";
import { cx } from "../../ui/cx.ts";
import "./tailnet.css";

/** one row of the list: a device on the tailnet, or this machine itself at the top */
export interface TailnetRow {
  key: string;
  name: string;
  /** after the name, for a machine with a name of its own; nothing for a phone */
  host?: string;
  /** the dot: answered from here just now, or for this machine, connected at all */
  reached: boolean;
  /** what the row says on its right: a word, a control, a word beside a control, or nothing */
  right?: ReactNode;
}

/** The tailnet as a list, one row per device, one line each: a dot for whether it is reached
 * from here, the name, a machine's address after it, and whatever the card puts on the right.
 * A dot is read, so it takes the two inks the worktree dots use for up and doing nothing. */
export function TailnetRows({ rows }: { rows: TailnetRow[] }) {
  return (
    <div className="tailnet-list">
      {rows.map((r) => (
        <div key={r.key} className="tailnet-row">
          <div className="tailnet-peer">
            <span
              className={cx("dot tailnet-dot", r.reached ? "tailnet-reached" : "tailnet-unreached")}
              role="img"
              aria-label={r.reached ? "connected" : "not connected"}
            />
            <span className="tailnet-name">{r.name}</span>
            {r.host && <span className="hint tailnet-host">{r.host}</span>}
          </div>
          {r.right !== undefined && r.right !== null && (
            <span className={cx("tailnet-right", typeof r.right === "string" && "hint")}>{r.right}</span>
          )}
        </div>
      ))}
    </div>
  );
}

/** a device's row; a machine with a name of its own shows it, since that is what gets knocked at */
export const deviceRow = (d: TailnetDevice, right?: ReactNode): TailnetRow => ({
  key: d.host || d.name,
  name: d.toyon?.machine ?? d.name,
  host: d.kind === "machine" && d.host ? d.host : undefined,
  reached: d.reached,
  right,
});
