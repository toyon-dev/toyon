import { describe, expect, test } from "bun:test";
import { planName, planTitle } from "./planTitle.ts";

describe("the plan row's name for the plan", () => {
  test("the first heading, however it is levelled or closed", () => {
    expect(planTitle("# Bonn bagel bake: review of the notes and a revised plan\n\n## Context\n")).toBe(
      "Bonn bagel bake: review of the notes and a revised plan",
    );
    expect(planTitle("\n\n## Rename README ##\ntext")).toBe("Rename README");
    expect(planTitle("<!-- written by the agent -->\n# Plan\n")).toBe("Plan");
  });

  test("a plan that opens with prose has no title, and a bare hash line is not one", () => {
    expect(planTitle("Rename the file, then update the link.\n\n# Later heading\n")).toBeNull();
    expect(planTitle("#\n# Plan")).toBeNull();
    expect(planTitle("")).toBeNull();
  });

  test("a file with no heading goes by its name", () => {
    expect(planName(".toyon/plans/plan-how-to-rename-effervescent-owl.md")).toBe("plan-how-to-rename-effervescent-owl");
    expect(planName(".toyon/plans/2.md")).toBe("2");
  });
});
