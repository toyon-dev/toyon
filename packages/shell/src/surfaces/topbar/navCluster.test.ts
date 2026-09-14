import { describe, expect, test } from "bun:test";
import { NAV_GAP_PX, NAV_MAX_PX, navCluster } from "./navCluster.ts";

const bar = { winW: 1400, leadRight: 180, toolsLeft: 1300 };
const centre = (left: number, right: number) => ({ left, right });

describe("navCluster", () => {
  test("centred over the centre, at its full width, when there is room", () => {
    const c = navCluster({ ...bar, centre: centre(220, 980) });
    expect(c.width).toBe(NAV_MAX_PX);
    expect(c.left + c.width / 2).toBe(600);
  });
  test("no wider than 40% of the window", () => {
    expect(navCluster({ ...bar, winW: 1000, toolsLeft: 900, centre: centre(0, 1000) }).width).toBe(400);
  });
  test("a narrow centre caps it, a gap each side", () => {
    const c = navCluster({ ...bar, centre: centre(300, 620) });
    expect(c.width).toBe(320 - 2 * NAV_GAP_PX);
    expect(c.left).toBe(300 + NAV_GAP_PX);
  });
  test("a lead reaching past the left dock pushes it right, no further than it must", () => {
    const c = navCluster({ ...bar, leadRight: 260, centre: centre(192, 600) });
    expect(c.left).toBe(260 + NAV_GAP_PX);
  });
  test("with the left dock closed the pill is still cleared", () => {
    const c = navCluster({ ...bar, centre: centre(0, 400) });
    expect(c.left).toBeGreaterThanOrEqual(180 + NAV_GAP_PX);
  });
  test("the tools hold it back from the right", () => {
    const c = navCluster({ ...bar, toolsLeft: 900, centre: centre(0, 1400) });
    expect(c.left + c.width).toBe(900 - NAV_GAP_PX);
  });
  test("when the lead and the tools cannot both be had, the lead is cleared", () => {
    const c = navCluster({ ...bar, toolsLeft: 700, centre: centre(0, 1400) });
    expect(c.left).toBe(180 + NAV_GAP_PX);
  });
});
