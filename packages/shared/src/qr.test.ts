import { expect, test } from "bun:test";
import { pairLink } from "./pair.ts";
import { qrModules, qrText } from "./qr.ts";

test("a short string is the smallest code, square, with its three finder corners dark", () => {
  const m = qrModules("hi");
  expect(m.length).toBe(21);
  for (const row of m) expect(row.length).toBe(21);
  expect(m[0]?.[0]).toBe(true);
  expect(m[0]?.[20]).toBe(true);
  expect(m[20]?.[0]).toBe(true);
});

test("a pair link on a long tailnet name stays coarse enough to scan across a desk", () => {
  const url = pairLink("a-rather-long-machine-name.tail1234ab.ts.net", "AbCdEfGhIjKl");
  // version 6 is 41 modules
  expect(qrModules(url).length).toBeLessThanOrEqual(41);
});

test("the text form has a line per two module rows and a light quiet zone", () => {
  const m = qrModules("hi");
  const lines = qrText(m, 2).split("\n");
  expect(lines.length).toBe(Math.ceil((21 + 4) / 2));
  for (const line of lines) expect([...line].length).toBe(25);
  expect(lines[0]).toBe("█".repeat(25));
});
