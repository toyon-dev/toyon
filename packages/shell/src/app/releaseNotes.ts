import { newer } from "@toyon/shared";

/** The what's-new chip in the bar: the word on it and its tip, for the first page after Toyon
 * updated itself from `from` to `to`. */
export function notesOfferText(from: string, to: string): { word: string; text: string } {
  return {
    word: `what's new in ${to}`,
    text: `Toyon updated from ${from} to ${to} since this browser last opened it. Press to read what changed`,
  };
}

/** what the release notes view says over the notes: where they are from, and where to look */
export function notesLead(ranBefore: string | null, version: string, notes: "reading" | "missing" | "ready"): string {
  if (notes === "reading") return "Reading the release notes";
  if (notes === "missing") return "No release notes could be read from this Toyon.";
  if (ranBefore !== null && newer(version, ranBefore)) {
    return `Toyon ${version} is running. This browser last opened ${ranBefore}; everything since is at the top.`;
  }
  return `Toyon ${version} is running. Every release, newest first.`;
}
