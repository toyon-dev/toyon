import { expect, test } from "bun:test";
import { launcherAddLink } from "./launcher.ts";

test("the add link carries the machine's origin, encoded, and nothing else", () => {
  expect(launcherAddLink("https://my-toyon.fly.dev")).toBe("https://toyon.cloud/#add=https%3A%2F%2Fmy-toyon.fly.dev");
});
