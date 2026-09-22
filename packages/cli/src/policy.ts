// The managed policy as the CLI meets it: a verb the policy turns off refuses before it does
// anything, and names the file that said so, since the person typing it did not write that file.

import type { ManagedResolved } from "@toyon/shared";

/** the refusal, printed; the verb's exit code */
export function refusedByPolicy(verb: string, m: ManagedResolved): number {
  console.error(`toyon: ${verb} is turned off by your organization's policy (${m.source ?? "policy"})`);
  return 1;
}
