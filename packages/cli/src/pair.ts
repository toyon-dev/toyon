// `toyon pair`: a one-time code for a phone, drawn in the terminal to scan. The phone opens the
// remote name with the code, trades it for the token, and adds the machine to toyon.cloud.

import type { PairMint } from "@toyon/shared";
import { qrModules, qrText } from "@toyon/shared/qr";
import { base, health, readToken } from "./daemon.ts";

/** Mint a code from the running daemon and print it. Answers the line to print instead when the
 * daemon refuses, so `toyon remote` can say it in its own place. */
export async function printPairCode(): Promise<string | null> {
  const token = readToken();
  if (!token) return "daemon token missing; `toyon doctor` says where it looked";
  let res: Response;
  try {
    res = await fetch(`${base}/pair`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  } catch {
    return "Toyon is not running. Start it with `toyon`, then run `toyon pair`.";
  }
  if (!res.ok) return (await res.text()) || `the daemon refused a pairing code (${res.status})`;
  const mint = (await res.json()) as PairMint;
  console.log(`\n${qrText(qrModules(mint.url))}\n`);
  console.log("Scan with your phone's camera. The code works once and lasts 2 minutes.");
  console.log(mint.url);
  return null;
}

export async function pair(): Promise<number> {
  if (!(await health())) {
    console.error("toyon: Toyon is not running. Start it with `toyon`, then run `toyon pair`.");
    return 1;
  }
  const refused = await printPairCode();
  if (refused) {
    console.error(`toyon: ${refused}`);
    return 1;
  }
  return 0;
}
