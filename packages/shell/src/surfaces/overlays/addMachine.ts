// The words on the add-machine card, apart from the card: what each way a pairing can fail reads
// as, so the lines are tested and the component only picks one.

import type { RedeemFailure } from "../../ws.ts";

export const ADD_MACHINE = {
  title: "Add a machine",
  lead: "Point the camera at the code on its screen, or paste the link.",
  placeholder: "https://",
  pasteOnly: "Paste the link from the code on its screen.",
  notALink: "That is not a Toyon link. It starts with https:// and ends in #pair= or #token=.",
  asking: (origin: string) => `Asking ${hostOf(origin)}.`,
  added: (name: string) => `Added ${name}.`,
  add: "add",
} as const;

/** `work.tail1234.ts.net` out of an origin, for a line that names the machine */
export function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** why a machine could not be added, in a sentence that says what to do next */
export function failureLine(failure: RedeemFailure, origin: string): string {
  const host = hostOf(origin);
  switch (failure) {
    case "expired":
      return "This code has expired; show a new one on the other machine.";
    case "not-toyon":
      return `${host} is not a Toyon machine, or has no remote name set up.`;
    case "unreachable":
      return `${host} did not answer. Is Tailscale on here, and is Toyon running there?`;
  }
}
