// Pairing: how a phone that never saw the token gets it. A shell that holds the token asks the
// daemon for a code, shows it as a QR, and the phone's camera opens the machine's own address with
// the code in the fragment. The page trades the code for the token once. The token is never drawn,
// printed or photographed, and a code is worth nothing two minutes later.

/** how long a code can be redeemed after it is minted */
export const PAIR_TTL_MS = 120_000;

/** the fragment the phone opens; the inline boot script in the shell's index.html reads the same
 * shape, spelled out there because it runs before any module */
export const pairLink = (host: string, code: string): string => `https://${host}/#pair=${code}`;

/** what `POST /pair` answers: the code, the link the QR carries, and how long is left. A duration
 * rather than a time, because the desk showing the countdown may not share the daemon's clock. */
export interface PairMint {
  code: string;
  url: string;
  ms: number;
}

/** what `POST /pair/redeem` answers for a live code */
export interface PairRedeem {
  token: string;
}
