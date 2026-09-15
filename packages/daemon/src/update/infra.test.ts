import { describe, expect, test } from "bun:test";
import { runInstall } from "./infra.ts";

describe("runInstall", () => {
  test("a failure keeps the line that says why, not npm's pointer to its log", async () => {
    const r = await runInstall([
      "sh",
      "-c",
      "echo 'npm error code EACCES' >&2; echo 'npm error A complete log of this run can be found in: /x.log' >&2; exit 1",
    ]);
    expect(r).toEqual({ ok: false, line: "npm error code EACCES" });
  });

  test("a command that is not there is a failure, not a throw", async () => {
    const r = await runInstall(["toyon-no-such-command"]);
    expect(r.ok).toBe(false);
  });
});
