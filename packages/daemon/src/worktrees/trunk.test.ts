import { expect, spyOn, test } from "bun:test";
import { registered, useWorld, w } from "../../test/helpers/world.ts";
import { Trunk } from "./trunk.ts";

useWorld();

test("a fetch failure is said once per outage, and once more when origin answers again", async () => {
  const repoId = await registered();
  const path = w.state.repo(repoId)!.path;
  const trunk = new Trunk({ state: w.state, hub: w.hub, counts: () => undefined, invalidateCounts: () => {} });
  const dns = "fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com\n";
  const written: string[] = [];
  const stderr = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
  try {
    trunk.noteFetch(repoId, { ok: false, err: dns });
    trunk.noteFetch(repoId, { ok: false, err: dns });
    trunk.noteFetch(repoId, { ok: false, err: dns });
    trunk.noteFetch(repoId, { ok: true, err: "" });
    trunk.noteFetch(repoId, { ok: true, err: "" });
    trunk.noteFetch(repoId, { ok: false, err: "ssh: connect to host github.com port 22: Operation timed out" });
  } finally {
    stderr.mockRestore();
  }
  const lines = written.filter((l) => l.includes("[fetch]")).map((l) => l.replace(/^[0-9:]{8} /, "").trimEnd());
  expect(lines).toEqual([
    `warn  [fetch] could not fetch ${path}: ${dns.trim()}`,
    `info  [fetch] origin answers again for ${path}`,
    `warn  [fetch] could not fetch ${path}: ssh: connect to host github.com port 22: Operation timed out`,
  ]);
  // the trunk still carries the current failure for the rows
  expect(trunk.all()[repoId]?.fetchFailed).toContain("Operation timed out");
});
