// One question on the terminal, answered with a line. `uninstall` and `pair` both ask this way.

/** `question [y/N]`, answered with a y; a closed stdin is a no */
export function confirm(question: string): Promise<boolean> {
  process.stdout.write(`${question} [y/N] `);
  return new Promise((resolve) => {
    process.stdin.once("data", (chunk) => resolve(String(chunk).trim().toLowerCase().startsWith("y")));
    process.stdin.once("end", () => resolve(false));
  });
}
