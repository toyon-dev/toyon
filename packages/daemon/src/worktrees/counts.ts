// The rail's badge numbers: how far each row is ahead of and behind its base, what it has not
// pushed, and how many files it has changed. Reading them is git, twice per row and across every
// row, and a frame goes out on every proc event; so no frame reads them. A frame takes what is
// known, whatever its age, and asks for what is older than the floor to be read again behind it.
// Whoever asked decides what a changed number is worth: a frame of its own, or nothing.

export interface RowCounts {
  ahead?: number;
  behind?: number;
  unpushed?: number;
  dirty?: number;
}

/** how old a number may be before a frame has it read again: a dev-server log line should not
 * shell out to git, and a real change is caught by the signals that know of it (a turn ending, a
 * HEAD an op moved, main moving), not by this */
export const COUNTS_FLOOR_MS = 10_000;

export interface CountsDeps {
  /** git, for one row: null for a row that is gone */
  read: (id: string) => Promise<RowCounts | null>;
  /** a row whose directory is being removed. A forced remove empties a big tree over seconds and
   * git answers honestly about a half-empty one, so a read in that window would report every file
   * still in it as deleted. The last numbers stand, and the row goes a moment later anyway. */
  going: (id: string) => boolean;
}

const same = (a: RowCounts, b: RowCounts) =>
  a.ahead === b.ahead && a.behind === b.behind && a.unpushed === b.unpushed && a.dirty === b.dirty;

export class Counts {
  /** `value` is missing for a row whose first read failed, and `failed` set when the last read
   * did: the floor still applies, so a row git cannot answer for (a tree still being made, a lock
   * held) is asked again after it, not on every frame */
  private cache = new Map<string, { value?: RowCounts; at: number; failed?: boolean }>();
  /** reads under way, by row: a second ask for a row being read waits on that read */
  private reading = new Map<string, Promise<boolean>>();
  /** how many times each row, and every row at once, was marked stale: a read that began before a
   * mark answers for the tree before it, and is not kept */
  private marks = new Map<string, number>();
  private markAll = 0;

  constructor(private d: CountsDeps) {}

  /** the numbers as last read, whatever their age; nothing for a row never read */
  get(id: string): RowCounts | undefined {
    return this.cache.get(id)?.value;
  }

  /** the numbers are known to be wrong (this row's HEAD or files moved; every row's when main
   * did): the next ask reads again, a read in flight reads again when it lands, and what stands
   * until then is the last number rather than none, so a badge does not blink out while git is
   * asked */
  stale(id?: string) {
    if (id === undefined) {
      this.markAll++;
      for (const c of this.cache.values()) c.at = 0;
      return;
    }
    this.marks.set(id, (this.marks.get(id) ?? 0) + 1);
    const c = this.cache.get(id);
    if (c) c.at = 0;
  }

  /** a number read on some other errand (a status push): kept, and true when it moved */
  put(id: string, value: RowCounts): boolean {
    return this.store(id, value);
  }

  /** The rows named whose numbers are missing or older than the floor are read again. True when
   * any number moved; null when there was nothing to read. Reads run side by side, one per row at
   * a time; the frame that asked for them went out already, and the caller decides whether a moved
   * number is worth another. */
  refresh(ids: Iterable<string>): Promise<boolean> | null {
    const reads: Promise<boolean>[] = [];
    for (const id of new Set(ids)) {
      const running = this.reading.get(id);
      if (running) {
        reads.push(running);
        continue;
      }
      const cached = this.cache.get(id);
      if (cached && Date.now() - cached.at < COUNTS_FLOOR_MS) continue;
      if (this.d.going(id)) continue;
      reads.push(this.readOne(id));
    }
    if (!reads.length) return null;
    return Promise.all(reads).then((moved) => moved.some(Boolean));
  }

  /** the numbers read now, for a decision that must not rest on the last ones; null when git
   * could not say */
  async read(id: string): Promise<RowCounts | null> {
    this.stale(id);
    await this.refresh([id]);
    const c = this.cache.get(id);
    return c?.failed || !c?.value ? null : c.value;
  }

  private markOf(id: string): number {
    return (this.marks.get(id) ?? 0) + this.markAll;
  }

  private readOne(id: string): Promise<boolean> {
    const read = (async () => {
      for (;;) {
        const mark = this.markOf(id);
        let value: RowCounts | null = null;
        try {
          value = await this.d.read(id);
        } catch {
          // git could not say (a checkout mid-removal, a lock held): the last numbers stand, else
          // none, and a number not known reads as work to the archive rule, so the row is kept
        }
        // the removal started while the read was in flight: the number is the tree being deleted,
        // not the work, and it must not reach what the rail reads
        if (this.d.going(id)) return false;
        // a stale mark landed while git was answering: the answer is from before it, so ask again
        if (this.markOf(id) !== mark) continue;
        if (value) return this.store(id, value);
        this.cache.set(id, { value: this.get(id), at: Date.now(), failed: true });
        return false;
      }
    })().finally(() => {
      this.reading.delete(id);
    });
    this.reading.set(id, read);
    return read;
  }

  private store(id: string, value: RowCounts): boolean {
    const prev = this.cache.get(id)?.value;
    this.cache.set(id, { value, at: Date.now() });
    return !prev || !same(prev, value);
  }
}
