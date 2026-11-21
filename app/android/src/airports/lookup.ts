// Which airfield a point is at: for naming where a plane left from.
//
// region-airports.json is made by mac-server/build_airports.py from OurAirports (public domain):
// every airfield within 350 nm of Wood County, as rows of
// [code, name, city, lat, lon, elevationFt, kind]. The Mac has the same rules over the whole US and
// Canada (mac-server/airports.py): keep the two in step.

import rows from './region-airports.json';
import { haversineKm } from '../flights/geo';

/** "L" large, "M" medium, "S" small public-use, "P" private strip, "H" heliport. */
export type AirfieldKind = 'L' | 'M' | 'S' | 'P' | 'H';

export type Airfield = {
  /** FAA or IATA identifier: "1G0", "TOL". */
  code: string;
  /** "Wood County Airport" */
  name: string;
  city: string;
  lat: number;
  lon: number;
  /** Feet above mean sea level. */
  elevationFt: number | null;
  kind: AirfieldKind;
};

export type NearAirfield = Airfield & { distanceNm: number };

export type Nearest = (lat: number, lon: number, opts?: { maxNm?: number; helicopter?: boolean; publicOnly?: boolean }) => NearAirfield | null;

const KM_PER_NM = 1.852;
/** A private strip is believed only when the point is right on it and no public field is about as close. */
const PRIVATE_WITHIN_NM = 1;
/** A heliport only for a helicopter, and only when it is on top of it. */
const HELIPORT_WITHIN_NM = 0.5;
/** Grid cell size in degrees: a lookup reads the few cells around the point, not the whole list. */
const CELL_DEG = 0.25;

type Row = [string, string, string, number, number, number | null, AirfieldKind];

const cellOf = (deg: number) => Math.floor(deg / CELL_DEG);

/** A lookup over a list of airfields (rows as in region-airports.json). */
export function airfieldLookup(list: Row[]): Nearest {
  const grid = new Map<string, Row[]>();
  for (const row of list) {
    const key = `${cellOf(row[3])}:${cellOf(row[4])}`;
    const cell = grid.get(key);
    if (cell) cell.push(row);
    else grid.set(key, [row]);
  }
  return (lat, lon, opts = {}) => {
    const maxNm = opts.maxNm ?? 5;
    const latSpan = maxNm / 60;
    const lonSpan = latSpan / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
    const best: Partial<Record<'public' | 'private' | 'heli', [number, Row]>> = {};
    for (let a = cellOf(lat - latSpan); a <= cellOf(lat + latSpan); a++) {
      for (let o = cellOf(lon - lonSpan); o <= cellOf(lon + lonSpan); o++) {
        for (const row of grid.get(`${a}:${o}`) ?? []) {
          const group = row[6] === 'P' ? 'private' : row[6] === 'H' ? 'heli' : 'public';
          if (group === 'heli' ? !opts.helicopter || opts.publicOnly : group === 'private' && opts.publicOnly) continue;
          const d = haversineKm(lat, lon, row[3], row[4]) / KM_PER_NM;
          const had = best[group];
          if (d <= maxNm && (!had || d < had[0])) best[group] = [d, row];
        }
      }
    }
    // Public airports first: a private strip wins only from very close and when the nearest public
    // field is clearly farther.
    let pick = best.public;
    if (best.private && best.private[0] <= PRIVATE_WITHIN_NM && (!pick || pick[0] > 3 * best.private[0] + 1)) pick = best.private;
    if (best.heli && best.heli[0] <= HELIPORT_WITHIN_NM && (!pick || best.heli[0] < pick[0])) pick = best.heli;
    if (!pick) return null;
    const [code, name, city, flat, flon, elevationFt, kind] = pick[1];
    return { code, name, city, lat: flat, lon: flon, elevationFt, kind, distanceNm: pick[0] };
  };
}

let regional: Nearest | null = null;

/** The airfield a point most likely belongs to, within `maxNm` (default 5), or null. */
export const nearestAirfield: Nearest = (lat, lon, opts) => {
  regional ??= airfieldLookup(rows as unknown as Row[]);
  return regional(lat, lon, opts);
};

/** Longest name a card line has room for next to "From … · 25 min ago". */
const CARD_NAME_MAX = 24;

/**
 * A name short enough for a card: "Wood County", "Toledo Executive", "Findlay"; for a long one the
 * town and the code ("Detroit (DTW)").
 */
export function shortName(field: Pick<Airfield, 'code' | 'name' | 'city' | 'kind'>): string {
  const name = field.name
    .replace(/\s+(?:Airport|Airpark|Airfield|Landing Strip|Heliport|Helistop)$/i, '')
    .replace(/\s+(?:Municipal|Regional|International|Metropolitan|Memorial)$/i, '')
    .trim();
  if (name.length <= CARD_NAME_MAX) return name || field.code;
  if (field.city && field.kind !== 'H' && field.kind !== 'P') return `${field.city} (${field.code})`;
  return `${name.slice(0, CARD_NAME_MAX - 1).trimEnd()}…`;
}
