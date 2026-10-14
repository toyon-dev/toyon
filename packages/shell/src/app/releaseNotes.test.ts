import { describe, expect, test } from "bun:test";
import { notesLead, notesOfferText } from "./releaseNotes.ts";

describe("notesOfferText", () => {
  test("names the version on the chip and both versions in the tip", () => {
    expect(notesOfferText("0.11.0", "0.14.0")).toEqual({
      word: "what's new in 0.14.0",
      text: "Toyon updated from 0.11.0 to 0.14.0 since this browser last opened it. Press to read what changed",
    });
  });
});

describe("notesLead", () => {
  test("while the daemon is asked, and when it has none", () => {
    expect(notesLead("0.11.0", "0.14.0", "reading")).toBe("Reading the release notes");
    expect(notesLead("0.11.0", "0.14.0", "missing")).toBe("No release notes could be read from this Toyon.");
  });
  test("after an update it says where to look", () => {
    expect(notesLead("0.11.0", "0.14.0", "ready")).toBe(
      "Toyon 0.14.0 is running. This browser last opened 0.11.0; everything since is at the top.",
    );
  });
  test("opened for its own sake it only says what is here", () => {
    const line = "Toyon 0.14.0 is running. Every release, newest first.";
    expect(notesLead(null, "0.14.0", "ready")).toBe(line);
    expect(notesLead("0.14.0", "0.14.0", "ready")).toBe(line);
    // a newer version was run before: nothing since is newer than what was seen
    expect(notesLead("0.15.0", "0.14.0", "ready")).toBe(line);
  });
});
