import { describe, expect, test } from "bun:test";
import { landPrompt, parseLanding } from "./landing.ts";

describe("parseLanding", () => {
  test("a ready verdict carries the recap, the subject and body, with the model's punctuation scrubbed", () => {
    const v = parseLanding(
      // prose-ignore: the model's punctuation, which the parser is here to scrub
      "READY\n\nRecap: **Dark mode** is in — check the toggle next.\n\nshell: dark mode with a no-flash script\n\nColours move to variables on :root — the toggle persists the choice.\nA pre-paint script reads it → no flash.",
    );
    expect(v).toEqual({
      ready: true,
      recap: "Dark mode is in, check the toggle next.",
      subject: "shell: dark mode with a no-flash script",
      body: "Colours move to variables on :root, the toggle persists the choice.\nA pre-paint script reads it to no flash.",
    });
  });

  test("not ready keeps the reason and still offers the message", () => {
    const v = parseLanding(
      "NOT READY: the agent asked which palette to use\n\nRecap: dark palette started; the agent is asking which one.\n\nadd a dark palette\n\nOnly the variables so far.",
    );
    expect(v).toMatchObject({
      ready: false,
      why: "the agent asked which palette to use",
      recap: "dark palette started; the agent is asking which one.",
      subject: "add a dark palette",
      body: "Only the variables so far.",
    });
  });

  test("a reply that skips the recap is still a message: labelled or not, two paragraphs are subject and body", () => {
    expect(parseLanding("READY\n\nadd a dark palette\n\nOnly the variables so far.")).toEqual({
      ready: true,
      subject: "add a dark palette",
      body: "Only the variables so far.",
    });
    // an unlabelled first paragraph counts as the recap only when the message follows it whole
    expect(parseLanding("READY\n\nDark palette is in.\n\nadd a dark palette\n\nOnly the variables so far.")).toEqual({
      ready: true,
      recap: "Dark palette is in.",
      subject: "add a dark palette",
      body: "Only the variables so far.",
    });
  });

  test("markdown fences and labels are stripped, a trailing stop on the subject goes", () => {
    const v = parseLanding(
      "```\nReady\n\nSubject: fix the header contrast.\n\nBody: The title was unreadable in dark.\n```",
    );
    expect(v).toEqual({ ready: true, subject: "fix the header contrast", body: "The title was unreadable in dark." });
  });

  test("an answer off the shape is no verdict, and a one-word subject is no subject", () => {
    expect(parseLanding("I cannot judge this.")).toBeNull();
    expect(parseLanding(null)).toBeNull();
    expect(parseLanding("READY\n\nfix")).toEqual({ ready: true });
  });

  test("a long subject is cut to what the hook allows", () => {
    const v = parseLanding(`READY\n\n${"word ".repeat(30)}`);
    expect(v?.subject?.length).toBeLessThanOrEqual(72);
  });
});

describe("landPrompt", () => {
  const turn = (asks: string[], reply: string) => ({ asks, reply, edits: 1, toolErrors: 0, newestTs: 1 });

  test("carries the task, the recent subjects, the newest turns and the diff", () => {
    const p = landPrompt({
      title: "dark mode",
      firstAsk: "make a dark mode",
      turns: [turn(["make a dark mode"], "Dark mode is in."), turn(["fix the flash"], "Fixed the flash.")],
      diffStat: " src/App.tsx | 12 ++++",
      recentSubjects: ["shell: three comments that outlived what they described"],
    });
    expect(p).toContain("Task: dark mode");
    expect(p).toContain("Recent commit subjects:\n  shell: three comments");
    expect(p).toContain("User asked: fix the flash");
    expect(p).toContain("Diff summary:\nsrc/App.tsx | 12 ++++");
    expect(p.indexOf("make a dark mode")).toBeLessThan(p.indexOf("fix the flash"));
  });

  test("drops the oldest turns first when the prompt runs long", () => {
    // each block is clipped on its own (asks to 400, the reply to 1000), so four of them at full
    // size is what overruns the budget
    const ask = (word: string) => `${word} ${"y".repeat(400)}`;
    const long = "x".repeat(2_000);
    const p = landPrompt({
      title: "t",
      turns: [
        turn([ask("first")], long),
        turn([ask("second")], long),
        turn([ask("third")], long),
        turn([ask("fourth")], long),
      ],
      diffStat: "",
      recentSubjects: [],
    });
    expect(p).not.toContain("User asked: first");
    expect(p).toContain("User asked: fourth");
  });
});
