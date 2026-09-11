import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionOption, RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { decide, pickOption, requestedPaths } from "./policy.ts";
import type { Bounds } from "./sandbox.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "toyon-policy-")));
const wt = join(root, "wt");
mkdirSync(join(wt, "src"), { recursive: true });
mkdirSync(join(root, "outside"));
symlinkSync(join(root, "outside"), join(wt, "escape"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const bounds: Bounds = {
  root: wt,
  allowWrite: [wt, "/tmp", "/private/tmp"],
  denyWrite: [join(wt, ".claude")],
  gitDir: null,
};

const req = (toolCall: Omit<RequestPermissionRequest["toolCall"], "toolCallId">): RequestPermissionRequest => ({
  sessionId: "s",
  toolCall: { toolCallId: "t1", ...toolCall },
  options: [],
});

const claudeOptions: PermissionOption[] = [
  { optionId: "allow-once", name: "Allow", kind: "allow_once" },
  { optionId: "allow-with-updates", name: "Always", kind: "allow_always" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
];
const codexOptions: PermissionOption[] = [
  { optionId: "allow_once", name: "Allow", kind: "allow_once" },
  { optionId: "allow_session", name: "Session", kind: "allow_always" },
  { optionId: "cancel", name: "Cancel", kind: "reject_once" },
];

describe("policy.decide", () => {
  test("edit inside the worktree via ACP locations (codex shape) is allowed", () => {
    const v = decide(
      req({ kind: "edit", title: "Edit files", locations: [{ path: join(wt, "src/a.ts") }] }),
      bounds,
      wt,
    );
    expect(v.kind).toBe("allow");
  });

  test("edit inside via rawInput.file_path (claude shape) is allowed; relative paths resolve against cwd", () => {
    expect(decide(req({ kind: "edit", name: "Edit", rawInput: { file_path: join(wt, "x") } }), bounds, wt).kind).toBe(
      "allow",
    );
    expect(decide(req({ kind: "edit", name: "Write", rawInput: { file_path: "src/new.ts" } }), bounds, wt).kind).toBe(
      "allow",
    );
  });

  test("outside the worktree is rejected with a reason naming Toyon, not the person", () => {
    const v = decide(
      req({ kind: "edit", name: "Write", rawInput: { file_path: join(root, "outside/z") } }),
      bounds,
      wt,
    );
    expect(v.kind).toBe("reject");
    if (v.kind === "reject") {
      expect(v.tool).toBe("Write");
      expect(v.reason).toContain("outside this worktree");
      expect(v.reason).toContain("Toyon");
    }
  });

  test("a symlink inside pointing out is caught", () => {
    const v = decide(req({ kind: "edit", name: "Edit", rawInput: { file_path: join(wt, "escape/z") } }), bounds, wt);
    expect(v.kind).toBe("reject");
  });

  test(".claude/ is denied even though it is inside", () => {
    const v = decide(
      req({ kind: "edit", name: "Write", locations: [{ path: join(wt, ".claude/settings.json") }] }),
      bounds,
      wt,
    );
    expect(v.kind).toBe("reject");
    if (v.kind === "reject") expect(v.reason).toContain("managed by Toyon");
  });

  test("execute / read / search with no paths are allowed; an edit with no path is not", () => {
    expect(
      decide(req({ kind: "execute", title: "bun test", rawInput: { command: "bun test" } }), bounds, wt).kind,
    ).toBe("allow");
    expect(decide(req({ kind: "read", title: "Read" }), bounds, wt).kind).toBe("allow");
    expect(decide(req({ kind: "edit", title: "Edit files" }), bounds, wt).kind).toBe("reject");
  });

  test("ask mode turns inside writes and commands into a card; reads stay free and outside stays refused", () => {
    const edit = req({ kind: "edit", title: "Edit", locations: [{ path: join(wt, "src", "a.ts") }] });
    expect(decide(edit, bounds, wt, "ask").kind).toBe("prompt");
    expect(decide(edit, bounds, wt, "plan").kind).toBe("prompt");
    expect(decide(edit, bounds, wt, "auto").kind).toBe("allow");
    const run = req({ kind: "execute", title: "bun test", rawInput: { command: "bun test" } });
    expect(decide(run, bounds, wt, "ask").kind).toBe("prompt");
    expect(
      decide(req({ kind: "read", title: "Read", locations: [{ path: join(wt, "a.ts") }] }), bounds, wt, "ask").kind,
    ).toBe("allow");
    expect(decide(req({ kind: "search", title: "Grep" }), bounds, wt, "ask").kind).toBe("allow");
    const outside = req({ kind: "edit", title: "Edit", locations: [{ path: "/etc/hosts" }] });
    expect(decide(outside, bounds, wt, "ask").kind).toBe("reject");
    expect(decide(req({ kind: "switch_mode", title: "Approve Plan" }), bounds, wt, "auto").kind).toBe("prompt");
  });

  test("requestedPaths merges locations and raw input keys without duplicates", () => {
    const r = req({ locations: [{ path: "/a" }], rawInput: { file_path: "/a", path: "/b", paths: ["/c", 1] } });
    expect(requestedPaths(r)).toEqual(["/a", "/b", "/c"]);
  });
});

describe("policy.pickOption", () => {
  test("allow picks allow_once, never allow_always", () => {
    expect(pickOption(claudeOptions, { kind: "allow" })).toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
    expect(pickOption(codexOptions, { kind: "allow" })).toEqual({
      outcome: { outcome: "selected", optionId: "allow_once" },
    });
  });

  test("reject prefers a reject that is not a cancel, falls back to cancel, then to cancelled", () => {
    const reject = { kind: "reject" as const, tool: "t", path: "p", reason: "r" };
    expect(pickOption(claudeOptions, reject)).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
    expect(pickOption(codexOptions, reject)).toEqual({ outcome: { outcome: "selected", optionId: "cancel" } });
    expect(pickOption([claudeOptions[0]!], reject)).toEqual({ outcome: { outcome: "cancelled" } });
  });
});
