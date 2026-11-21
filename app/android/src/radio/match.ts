// Which plane is a radio call about? The Mac hands over the callsigns it heard ("DAL1830", "901BG");
// the phone has the traffic, so the matching happens here.

import type { Plane } from '@web/planes';

const tidy = (s: string | null | undefined) => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
/** After first contact a tail number is said in short ("one Bravo Golf"): that many characters is enough. */
const MIN_SUFFIX = 3;

const nearest = (planes: Plane[]) => planes.reduce<Plane | null>((a, b) => (!a || b.distanceKm < a.distanceKm ? b : a), null);

/** The plane one token names: an exact callsign or tail number, else a tail number ending in it. Ties go to the closer plane. */
export function matchToken(token: string, planes: Plane[]): Plane | null {
  const t = tidy(token);
  if (!t) return null;
  const exact = planes.filter((p) => tidy(p.callsign) === t || tidy(p.registration) === t);
  if (exact.length) return nearest(exact);
  // Airline callsigns have to match in full: "DAL18" is not "DAL1830".
  if (t.length < MIN_SUFFIX || /^[A-Z]{3}\d/.test(t)) return null;
  // Tail numbers only (a registration, or an N-number flown as the callsign).
  const tails = (p: Plane) => [tidy(p.registration), /^N\d/.test(tidy(p.callsign)) ? tidy(p.callsign) : ''].filter(Boolean);
  return nearest(planes.filter((p) => tails(p).some((tail) => tail.endsWith(t))));
}

/** The plane a call is about: the first of its callsigns that matches something (a call starts with who it's for). */
export function matchCall(tokens: string[], planes: Plane[]): Plane | null {
  for (const token of tokens) {
    const plane = matchToken(token, planes);
    if (plane) return plane;
  }
  return null;
}
