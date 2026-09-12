import { describe, expect, test } from "bun:test";
import { type Waiting, waitingText } from "./waiting.ts";

/**
 * These sentences are the only interface the shell has while the daemon is down, which is exactly
 * why they went untested for so long: a working dev loop never shows them to anyone. They lived as
 * a five-deep ternary inside the markup until the centre's views were given a dress.
 */

const w = (over: Partial<Waiting> = {}): Waiting => ({
  connected: true,
  heard: true,
  connectFailure: null,
  hasToken: true,
  projectChord: "⌘O",
  title: "my-app",
  needsSetup: false,
  busy: false,
  treeEmpty: false,
  ...over,
});

describe("what the centre says while it waits", () => {
  test("a live socket over a running project says nothing: a view stands here instead", () => {
    expect(waitingText(w())).toBeNull();
  });

  test("the socket wins over everything, because nothing further is known yet", () => {
    expect(waitingText(w({ connected: false, heard: false }))).toContain("connecting");
    expect(waitingText(w({ connected: false, connectFailure: "down" }))).toContain("the daemon is not running");
    expect(waitingText(w({ connected: false, connectFailure: "unauthorized" }))).toContain("token is not the running");
    // a project mid-build does not get to speak while the socket is the real problem
    expect(waitingText(w({ connected: false, connectFailure: "down", needsSetup: true, busy: true }))).toContain(
      "daemon is not running",
    );
  });

  test("heard over the bootstrap fetch means the socket is a moment away, so it does not say down", () => {
    expect(waitingText(w({ connected: false, heard: true, connectFailure: null }))).toBeNull();
  });

  test("no token is its own sentence, since no failure explains it", () => {
    expect(waitingText(w({ connected: false, heard: false, hasToken: false }))).toContain("no access token");
  });

  test("nothing open names the chord that opens one, and stays blank before hello", () => {
    expect(waitingText(w({ title: null }))).toContain("⌘O");
    expect(waitingText(w({ title: null, heard: false }))).toBe("");
  });

  test("a project still arriving says which of the two things it is", () => {
    expect(waitingText(w({ needsSetup: true, busy: true }))).toBe(
      "building in my-app; the preview appears once it starts",
    );
    expect(waitingText(w({ needsSetup: true, treeEmpty: true }))).toBe("my-app is empty so far; say what to build");
    // building wins: an empty tree that is already being built is not waiting to be told anything
    expect(waitingText(w({ needsSetup: true, busy: true, treeEmpty: true }))).toContain("building in");
  });

  test("a set-up project that is merely idle says nothing; boot has more to tell than a sentence", () => {
    expect(waitingText(w({ needsSetup: false, treeEmpty: true }))).toBeNull();
  });
});
