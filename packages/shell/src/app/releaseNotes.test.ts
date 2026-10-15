import { describe, expect, test } from "bun:test";
import { notesLead, notesOfferText } from "./releaseNotes.ts";

describe("notesOfferText", () => {
  test("names the version on the chip and both versions in the tip", () => {
    expect(notesOfferText("0.11.0", "0.14.0")).toEqual({
      word: "what's new in 0.14.0",
      text: "Toyon updated from 0.11.0 to 0.14.0 since you last opened it here. Press to read what changed",
    });
  });
});

describe("notesLead", () => {
  test("while the daemon is asked, and when it has none", () => {
    expect(notesLead("0.14.0", "reading")).toBe("Reading the release notes");
    expect(notesLead("0.14.0", "missing")).toBe("No release notes could be read from Toyon 0.14.0.");
  });
});
