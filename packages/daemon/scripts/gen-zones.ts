// Regenerates `src/themes/zones.ts` from the tzdata table that macOS and Linux ship. Dev-time only:
// the daemon itself never reads /usr/share/zoneinfo, because Windows has no copy of it and a cloud
// daemon's own zone is the VM's rather than the person's.
//
//   bun run packages/daemon/scripts/gen-zones.ts
//
// zone.tab writes coordinates in two ISO 6709 widths, ±DDMM±DDDMM and ±DDMMSS±DDDMMSS, and the wide
// form covers America/New_York and America/Los_Angeles among others. Both are read here and written
// out as decimal degrees, so nothing at runtime has to know the format exists.

const SRC = "/usr/share/zoneinfo/zone.tab";
const OUT = new URL("../src/themes/zones.ts", import.meta.url).pathname;

/** ±DDMM[SS] / ±DDDMM[SS] to degrees; `wide` says the parts carry seconds */
function degrees(s: string, wide: boolean): number {
  const deg = Number(s.slice(1, s.length - (wide ? 4 : 2)));
  const rest = s.slice(s.length - (wide ? 4 : 2));
  const min = Number(rest.slice(0, 2));
  const sec = wide ? Number(rest.slice(2, 4)) : 0;
  const v = deg + min / 60 + sec / 3600;
  return s[0] === "-" ? -v : v;
}

const rows: string[] = [];
for (const line of (await Bun.file(SRC).text()).split("\n")) {
  if (line.startsWith("#") || !line.trim()) continue;
  const [, coord, tz] = line.split("\t");
  if (!coord || !tz) continue;
  // the latitude is signed and fixed width, so its length decides the form for both halves
  const wide = coord.length === 15;
  const lat = degrees(coord.slice(0, wide ? 7 : 5), wide);
  const lon = degrees(coord.slice(wide ? 7 : 5), wide);
  rows.push(`${tz} ${lat.toFixed(2)} ${lon.toFixed(2)}`);
}
rows.sort();

const out = `// Every IANA zone with the coordinates of the place it is named for, generated from the tzdata
// table by \`scripts/gen-zones.ts\`. It is here rather than in the shell because only one person in
// ten ever opens the appearance picker, and 12KB of it should not ride in every page load.
//
// The point is the zone's reference city, not the person, so sunrise is off by however far they are
// from it: a degree of longitude is four minutes, a degree of latitude about one at midlatitudes.
// That is the whole error budget, and it buys a feature that needs no location permission.

const TABLE = \`
${rows.join("\n")}
\`;

let index: Map<string, [number, number]> | null = null;

/** where a zone's reference city is, or null for one tzdata does not place (UTC, Etc/*) */
export function zoneCoords(tz: string): [number, number] | null {
  if (!index) {
    index = new Map();
    for (const row of TABLE.trim().split("\\n")) {
      const [name, lat, lon] = row.split(" ");
      if (name && lat && lon) index.set(name, [Number(lat), Number(lon)]);
    }
  }
  return index.get(tz) ?? null;
}
`;
await Bun.write(OUT, out);
console.log(`${rows.length} zones written to ${OUT}`);
