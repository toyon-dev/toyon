import { describe, expect, test } from "bun:test";
import { daylightNow } from "./daylight.ts";
import { zoneCoords } from "./zones.ts";

const HOUR = 3_600_000;

/** how long it stays light on the local day `at` falls in, in hours */
function dayLength(tz: string, at: Date): number {
  let cur = daylightNow(tz, at);
  // walk to the next sunrise, then measure to the sunset after it
  for (let i = 0; i < 4 && !cur.dark; i++) cur = daylightNow(tz, new Date(cur.until + 1000));
  const sunrise = cur.until;
  return (daylightNow(tz, new Date(sunrise + 1000)).until - sunrise) / HOUR;
}

describe("zone table", () => {
  test("places the zones a browser is most likely to report", () => {
    expect(zoneCoords("America/New_York")).toEqual([40.71, -74.01]);
    expect(zoneCoords("Europe/Berlin")).toEqual([52.5, 13.37]);
    // southern hemisphere: the latitude has to keep its sign
    expect(zoneCoords("Pacific/Auckland")).toEqual([-36.87, 174.77]);
  });

  test("has no place for the zones tzdata does not site", () => {
    expect(zoneCoords("UTC")).toBeNull();
    expect(zoneCoords("Etc/GMT+5")).toBeNull();
  });
});

describe("daylight", () => {
  test("the boundary is always ahead, and the state flips across it", () => {
    for (const tz of ["Europe/Berlin", "America/New_York", "Pacific/Auckland", "Asia/Kolkata", "UTC"]) {
      for (const month of [0, 3, 6, 9]) {
        const at = new Date(Date.UTC(2026, month, 15, 9, 30));
        const now = daylightNow(tz, at);
        expect(now.until).toBeGreaterThan(at.getTime());
        expect(daylightNow(tz, new Date(now.until + 1000)).dark).toBe(!now.dark);
      }
    }
  });

  test("an equinox is a twelve hour day everywhere, and a few minutes longer further north", () => {
    const equinox = new Date(Date.UTC(2026, 2, 20, 12));
    // refraction lifts the sun into view before its centre clears the horizon, and the further from
    // the equator the shallower its path through that band, so the overshoot grows with latitude
    const byLatitude = ["Africa/Nairobi", "Pacific/Auckland", "America/New_York", "Europe/Berlin", "Europe/Helsinki"];
    const lengths = byLatitude.map((tz) => dayLength(tz, equinox));
    for (const hours of lengths) expect(hours).toBeGreaterThan(12.05);
    for (const hours of lengths) expect(hours).toBeLessThan(12.4);
    expect(lengths).toEqual([...lengths].sort((a, b) => a - b));
  });

  test("the hemispheres take opposite solstices", () => {
    const june = new Date(Date.UTC(2026, 5, 21, 12));
    const december = new Date(Date.UTC(2026, 11, 21, 12));
    // Berlin and Sydney sit at similar distances from the equator, so their days trade places
    expect(dayLength("Europe/Berlin", june)).toBeGreaterThan(16);
    expect(dayLength("Europe/Berlin", december)).toBeLessThan(8.5);
    expect(dayLength("Australia/Sydney", june)).toBeLessThan(10);
    expect(dayLength("Australia/Sydney", december)).toBeGreaterThan(14);
  });

  test("the equator barely moves all year", () => {
    const march = dayLength("Africa/Nairobi", new Date(Date.UTC(2026, 2, 20, 12)));
    const june = dayLength("Africa/Nairobi", new Date(Date.UTC(2026, 5, 21, 12)));
    expect(Math.abs(march - june)).toBeLessThan(0.3);
  });

  test("inside the arctic circle the sun stays put, and the answer holds until midnight", () => {
    const polarNight = daylightNow("Arctic/Longyearbyen", new Date(Date.UTC(2026, 11, 21, 12)));
    expect(polarNight.dark).toBe(true);
    const polarDay = daylightNow("Arctic/Longyearbyen", new Date(Date.UTC(2026, 5, 21, 0)));
    expect(polarDay.dark).toBe(false);
    // no crossing to point at, so it says "ask again tomorrow" rather than naming a false sunrise
    expect(polarDay.until - Date.UTC(2026, 5, 21, 0)).toBeLessThanOrEqual(24 * HOUR);
  });

  test("a zone with no place falls back to fixed hours", () => {
    expect(daylightNow("UTC", new Date(Date.UTC(2026, 0, 15, 6, 59))).dark).toBe(true);
    expect(daylightNow("UTC", new Date(Date.UTC(2026, 0, 15, 7, 1))).dark).toBe(false);
    expect(daylightNow("UTC", new Date(Date.UTC(2026, 0, 15, 18, 59))).dark).toBe(false);
    expect(daylightNow("UTC", new Date(Date.UTC(2026, 0, 15, 19, 1))).dark).toBe(true);
  });

  test("the fallback reads those hours in the zone's own time, not UTC", () => {
    // 07:30 in Tokyo is 22:30 the day before in UTC; the fallback has to be light there
    expect(daylightNow("Etc/GMT-9", new Date(Date.UTC(2026, 0, 14, 22, 30))).dark).toBe(false);
  });
});
