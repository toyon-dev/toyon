// The one set of rows every connected page holds, and the frame that moves it. A page's hello
// carries the set as last published, every frame after it carries only the rows that changed, and
// a row is changed when its bytes on the wire are: the same JSON the stamp hashes, so "same" means
// one thing in both places. On a machine with a hundred rows a status tick is then one row and
// not a hundred, on every page at once.

import type { ServerMsg, TrunkStatus, WorktreeStatus } from "@toyon/shared";

export interface RowSet {
  rows: WorktreeStatus[];
  trunks: Record<string, TrunkStatus>;
}

export type RowsFrame = Extract<ServerMsg, { t: "worktrees" }>;

/** the stamp of a row set, as the hello's `stamps.rows` is: wyhash of `{ rows, trunks }` as JSON */
export const rowsStampOf = (rowsJson: readonly string[], trunksJson: string): string =>
  Bun.hash(`{"rows":[${rowsJson.join(",")}],"trunks":${trunksJson}}`).toString(16);

export class Published {
  private byId = new Map<string, { row: WorktreeStatus; json: string }>();
  private ids: string[] = [];
  private trunks: Record<string, TrunkStatus> = {};
  private trunksJson = "{}";
  private stampNow = "";

  /** the set every page holds, for the hello; empty until the first publish */
  current(): RowSet & { stamp: string } {
    return { rows: this.ids.map((id) => this.byId.get(id)!.row), trunks: this.trunks, stamp: this.stampNow };
  }

  /** Take `next` as the published set. Answers the frame that moves a page from the last set to
   * this one, or null when nothing moved: the rows whose bytes changed or that are new, every id
   * in order, the trunks when theirs changed, and the stamp of the whole. */
  publish(next: RowSet): RowsFrame | null {
    const seen = new Map<string, { row: WorktreeStatus; json: string }>();
    const ids: string[] = [];
    const jsons: string[] = [];
    const changed: WorktreeStatus[] = [];
    for (const row of next.rows) {
      const json = JSON.stringify(row);
      ids.push(row.id);
      jsons.push(json);
      if (this.byId.get(row.id)?.json !== json) changed.push(row);
      seen.set(row.id, { row, json });
    }
    const trunksJson = JSON.stringify(next.trunks);
    const trunksMoved = trunksJson !== this.trunksJson;
    const orderMoved = ids.length !== this.ids.length || ids.some((id, i) => id !== this.ids[i]);
    this.byId = seen;
    this.ids = ids;
    this.trunks = next.trunks;
    this.trunksJson = trunksJson;
    this.stampNow = rowsStampOf(jsons, trunksJson);
    if (changed.length === 0 && !trunksMoved && !orderMoved) return null;
    return {
      t: "worktrees",
      ids,
      rows: changed,
      ...(trunksMoved ? { trunks: next.trunks } : {}),
      stamp: this.stampNow,
    };
  }
}
