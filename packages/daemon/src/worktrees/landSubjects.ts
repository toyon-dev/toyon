// Marks written before a landing kept its subjects get them at boot, from the ref that kept each
// range, before any client reads the record. Pure over the marks and a reader, so the fill is
// tested with a fake one.

import type { LandMark } from "@toyon/shared";

/** a mark as a record from before subjects were kept holds it: the one place the field is read as
 * possibly missing */
type StoredLandMark = Omit<LandMark, "subjects"> & { subjects?: string[] };

/** whether a loaded mark still lacks its subjects */
export function unfilled(mark: LandMark): boolean {
  return (mark as StoredLandMark).subjects === undefined;
}

/** one mark to fill, and the checkout its range is read in */
export interface FillJob {
  mark: LandMark;
  cwd: string;
}

/** Fill every mark given, in place, a few reads at a time. A range git cannot read any more has
 * nothing to say, and is written as such: there is no later read that would do better. */
export async function fillLandMarks(
  jobs: readonly FillJob[],
  read: (cwd: string, mark: LandMark) => Promise<string[] | null>,
  width = 8,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      if (!job) return;
      job.mark.subjects = (await read(job.cwd, job.mark)) ?? [];
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, worker));
}
