// What a turn cost and how full the context is, in a form that reads at a glance. The agent
// reports cumulative figures (the session's spend so far, the context as of the last reply), so
// the per-turn number is a difference the store already took; this only formats.

/** tokens as people say them: 812, 9.5k, 42k, 200k */
export function tokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  return `${k < 10 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}k`;
}

/** dollars to the cent, and "<$0.01" rather than "$0.00" for a turn that cost something */
export function dollars(amount: number): string {
  if (amount > 0 && amount < 0.005) return "<$0.01";
  return `$${amount.toFixed(2)}`;
}

/** the row's text and its tip; `turn` absent when the agent reports no cost (a plan, a rate limit) */
export function usageLabel(u: { turn?: number; cost?: number; used: number; size: number }): {
  cost: string | null;
  context: string;
  tip: string;
} {
  const context = `${tokens(u.used)} of ${tokens(u.size)} context`;
  const pct = u.size > 0 ? Math.round((100 * u.used) / u.size) : 0;
  const tip =
    u.cost === undefined
      ? `${pct}% of the context window`
      : `${dollars(u.cost)} this session; ${pct}% of the context window`;
  return { cost: u.turn === undefined ? null : dollars(u.turn), context, tip };
}
