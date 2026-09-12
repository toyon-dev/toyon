// When the sun is up where the shell is, for the appearance mode that follows daylight rather than
// the OS. Pure arithmetic over the zone table: no location permission, no network, and nothing that
// asks macOS, whose own solar schedule only exists while its appearance is set to Auto, which is the
// one case where `follow system` already does the right thing.

import { zoneCoords } from "./zones.ts";

const DAY_MS = 86_400_000;
const RAD = Math.PI / 180;
/** the sun's centre this far below the horizon is the moment its disc appears, refraction included */
const HORIZON = -0.833;
/** what a zone with no coordinates gets: light between these hours, local time */
const FALLBACK_LIGHT = [7, 19] as const;

export interface Daylight {
  /** is it dark there now */
  dark: boolean;
  /** when that flips, epoch ms */
  until: number;
}

/** the zone's offset from UTC at that instant, in ms, DST included */
function offsetMs(tz: string, at: Date): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  const m = name?.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!m) return 0; // "GMT" itself, and anything Intl words differently
  const mins = Number(m[2]) * 60 + Number(m[3]);
  return (m[1] === "-" ? -mins : mins) * 60_000;
}

/** the next local midnight after `at`, as epoch ms */
function nextMidnight(tz: string, at: Date): number {
  const off = offsetMs(tz, at);
  const local = at.getTime() + off;
  return (Math.floor(local / DAY_MS) + 1) * DAY_MS - off;
}

/**
 * Sunrise and sunset around the solar noon nearest `at`, or which way the sun is stuck when there
 * is neither. The NOAA approximation: good to about a minute, which is well inside the error the
 * zone's reference city already costs us.
 */
function solar(at: Date, lat: number, lon: number): { rise: number; set: number } | "up" | "down" {
  const days = at.getTime() / DAY_MS + 2440587.5 - 2451545;
  // `n` numbers the solar days at this longitude, and noon on day n falls that much of a turn before
  // or after noon at Greenwich: the two terms carry opposite signs, and getting them to agree is
  // what keeps a zone near the date line on the right day
  const n = Math.round(days + lon / 360);
  const mean = 2451545 + 0.0009 + n - lon / 360;
  const anomaly = (357.5291 + 0.98560028 * (mean - 2451545)) % 360;
  const centre =
    1.9148 * Math.sin(anomaly * RAD) + 0.02 * Math.sin(2 * anomaly * RAD) + 0.0003 * Math.sin(3 * anomaly * RAD);
  const ecliptic = (anomaly + centre + 180 + 102.9372) % 360;
  const noon = mean + 0.0053 * Math.sin(anomaly * RAD) - 0.0069 * Math.sin(2 * ecliptic * RAD);
  const declination = Math.asin(Math.sin(ecliptic * RAD) * Math.sin(23.44 * RAD));
  const cosHour =
    (Math.sin(HORIZON * RAD) - Math.sin(lat * RAD) * Math.sin(declination)) /
    (Math.cos(lat * RAD) * Math.cos(declination));
  // past the poles' circles for part of the year there is no crossing to solve for
  if (cosHour > 1) return "down";
  if (cosHour < -1) return "up";
  const hour = Math.acos(cosHour) / RAD / 360;
  const toMs = (julian: number) => (julian - 2440587.5) * DAY_MS;
  return { rise: toMs(noon - hour), set: toMs(noon + hour) };
}

/** light between fixed hours, for a zone tzdata gives no place for: UTC, Etc/GMT+5, a name newer than the table */
function fixed(tz: string, at: Date): Daylight {
  const off = offsetMs(tz, at);
  const local = at.getTime() + off;
  const midnight = Math.floor(local / DAY_MS) * DAY_MS;
  const hour = (h: number) => midnight + h * 3_600_000 - off;
  const [up, down] = FALLBACK_LIGHT;
  if (at.getTime() < hour(up)) return { dark: true, until: hour(up) };
  if (at.getTime() < hour(down)) return { dark: false, until: hour(down) };
  return { dark: true, until: hour(up) + DAY_MS };
}

/** whether it is dark in `tz` now, and when that changes */
export function daylightNow(tz: string, at: Date = new Date()): Daylight {
  const coords = zoneCoords(tz);
  if (!coords) return fixed(tz, at);
  const [lat, lon] = coords;
  const now = at.getTime();

  // The nearest solar noon can fall either side of `at`, and a boundary can be missing on one day
  // and not the next, so the crossings of three days are collected and the next one is read off.
  const crossings: Array<{ at: number; rise: boolean }> = [];
  let stuck: "up" | "down" | null = null;
  for (let d = -1; d <= 1; d++) {
    const s = solar(new Date(now + d * DAY_MS), lat, lon);
    if (s === "up" || s === "down") {
      if (d === 0) stuck = s;
      continue;
    }
    crossings.push({ at: s.rise, rise: true }, { at: s.set, rise: false });
  }
  const next = crossings.filter((c) => c.at > now).sort((a, b) => a.at - b.at)[0];
  // midsummer or midwinter inside a polar circle: the state holds all day, so look again tomorrow
  if (!next) return { dark: stuck === "down", until: nextMidnight(tz, at) };
  return { dark: next.rise, until: next.at };
}
