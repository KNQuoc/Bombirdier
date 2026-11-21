// Port of flight-service/app/main.py (GET /api/flights/nearby) minus the HTTP layer and the cone
// filter: the app always wants every plane in the radius and does the cone per frame.

import type { Plane } from '@web/planes';
import { cachedRoute, fetchPoint, lookupRoutes } from './adsb';
import type { PointResult, Route } from './adsb';
import { normalize } from './normalize';
import type { RawAircraft } from './normalize';

/** AR radius used when the setting is blank. (flight-service defaults to 15 km.) */
export const DEFAULT_RADIUS_KM = 50;
/** The AR radius setting can't go above this: beyond it planes are specks and the view gets crowded. */
export const MAX_AR_RADIUS_KM = 100;
/** The list's reach: adsb.lol's maximum for one radius query. */
export const WIDE_RADIUS_NM = 250;
export const KM_PER_NM = 1.852;

/** Normalize, drop out-of-radius planes and duplicates, sort by distance. */
export function buildPlanes(raw: RawAircraft[], lat: number, lon: number, radiusKm: number): Plane[] {
  const planes: Plane[] = [];
  const seen = new Set<string>();
  for (const ac of raw) {
    const p = normalize(ac, lat, lon);
    if (!p || seen.has(p.id) || p.distanceKm > radiusKm) continue;
    seen.add(p.id);
    planes.push(p);
  }
  return planes.sort((a, b) => a.distanceKm - b.distanceKm);
}

export function applyRoutes(planes: Plane[], routeFor: (callsign: string) => Route | undefined): void {
  for (const p of planes) {
    const route = p.callsign ? routeFor(p.callsign) : undefined;
    if (route) [p.origin, p.destination] = route;
  }
}

/**
 * Live planes around (lat, lon) for the AR view. Routes come from the cache; missing ones are
 * looked up in the background and appear on a later call. Never throws.
 */
export async function livePlanes(
  lat: number,
  lon: number,
  radiusKm: number | null,
): Promise<{ planes: Plane[]; problem: PointResult['problem']; fetchedAt: number }> {
  const radius = radiusKm ?? DEFAULT_RADIUS_KM;
  const { ac, problem, fetchedAt } = await fetchPoint(lat, lon, radius / KM_PER_NM + 1); // +1 nm margin, trimmed by km below
  const planes = buildPlanes(ac, lat, lon, radius);
  applyRoutes(planes, cachedRoute);
  startRouteLookup(planes);
  return { planes, problem, fetchedAt };
}

let routeLookupInFlight = false;

function startRouteLookup(planes: Plane[]) {
  if (routeLookupInFlight) return;
  routeLookupInFlight = true;
  lookupRoutes(planes).finally(() => (routeLookupInFlight = false));
}

/**
 * Every plane within 250 nm, for the list and the radar. Routes are filled from the cache only:
 * looking up the whole set would mean a thousand requests. A plane opened from the list gets its
 * route through lookupRoutes([plane]). Never throws.
 */
export async function widePlanes(
  lat: number,
  lon: number,
): Promise<{ planes: Plane[]; problem: PointResult['problem']; fetchedAt: number; bytes: number }> {
  const { ac, problem, fetchedAt, bytes } = await fetchPoint(lat, lon, WIDE_RADIUS_NM);
  const planes = buildPlanes(ac, lat, lon, WIDE_RADIUS_NM * KM_PER_NM);
  applyRoutes(planes, cachedRoute);
  return { planes, problem, fetchedAt, bytes };
}
