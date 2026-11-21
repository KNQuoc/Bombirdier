// Port of flight-service/app/adsb.py: adsb.lol nearby aircraft + best-effort route lookup, both cached.
// The route lookup has since diverged from the Python (see lookupRoutes): Bombirdier looks routes up
// one callsign at a time, on demand, from adsb.lol's static route files.
//
// On the phone, fetch() is patched by CapacitorHttp and goes through native HTTP: api.adsb.lol sends
// no CORS headers, and native requests can set the User-Agent it checks. In a desktop browser
// (npm run dev) requests go through Vite's dev proxy instead. In Node (scripts/check-flights.mjs)
// they go straight to the API.

import type { Plane } from '@web/planes';
import { haversineKm } from './geo';
import type { RawAircraft } from './normalize';

const IS_NATIVE = Boolean((globalThis as any).Capacitor?.isNativePlatform?.());
const VIA_DEV_PROXY = typeof window !== 'undefined' && !IS_NATIVE;
const ADSB_LOL = VIA_DEV_PROXY ? '/proxy/adsb.lol' : 'https://api.adsb.lol';
// One small static JSON file per airline callsign (GitHub Pages, CORS open, so no proxy needed).
// api.adsb.lol/api/0/route/<callsign> redirects here. The batch endpoints the hackathon code used
// are gone: api.adsb.lol/api/0/routeset answers an empty 201, and adsb.im/api/0/routeset answers
// 403 without prior approval (checked 2026-11-20).
const ROUTE_FILES = 'https://vrs-standing-data.adsb.lol/routes';
const MAX_RADIUS_NM = 250;
// Generous: when a client polls a lot, adsb.lol's rate limiter answers slowly (seen on a phone:
// 2.5–7 s per request while the same URL took 0.5 s elsewhere). Giving up early doesn't help,
// since the server still counts the request, so wait for the answer and let the feed slow down.
const TIMEOUT_MS = 15_000;
// adsb.lol 403s generic client User-Agents.
export const USER_AGENT = 'Bombirdier/0.1 (Android; personal project)';

const POINT_TTL_MS = 1000; // shorter than the feed's 5 s poll, so every poll gets fresh data
const ROUTE_TTL_MS = 30 * 60 * 1000;
/** Callsigns whose lookup failed (network, server error): retry later, but not on every poll. */
const ROUTE_MISS_TTL_MS = 5 * 60 * 1000;
/** Only airline-style callsigns (DAL1830, SKW467F) have route files; N-numbers and the like never do. */
const ROUTABLE = /^[A-Z]{3}\d[A-Z0-9]*$/;
/** Route files fetched at once, and the most callsigns one lookupRoutes() call will fetch. */
const ROUTE_CONCURRENCY = 4;
const MAX_ROUTE_LOOKUPS = 40;

// Query center is snapped to a ~1 km grid (2 decimals) so GPS jitter doesn't create a new cache key
// (and a new upstream call) every poll. Callers recompute distance/bearing from the exact position
// and trim to the real radius; nearby.ts adds a 1 nm margin to cover the snap.
const KEY_DECIMALS = 2;
// adsb.lol rate-limits (429). Back off for Retry-After seconds (default below) instead of retrying.
// adsb.lol sends no Retry-After, so the default applies. The live feed also slows its own polling
// after a 429 (feed.ts), which is what actually finds a sustainable rate.
const RATE_LIMIT_BACKOFF_MS = 5000;

/** Tiny in-memory TTL cache (flight-service/app/cache.py). */
class TTLCache<V> {
  private data = new Map<string, { at: number; ttl: number; value: V }>();
  constructor(private ttlMs: number) {}

  get(key: string): V | undefined {
    const hit = this.data.get(key);
    return hit && Date.now() - hit.at <= hit.ttl ? hit.value : undefined;
  }

  /** The value even if expired (fallback when upstream is down). */
  getStale(key: string): V | undefined {
    return this.data.get(key)?.value;
  }

  set(key: string, value: V, ttlMs = this.ttlMs): void {
    this.data.set(key, { at: Date.now(), ttl: ttlMs, value });
  }
}

/** [origin, destination] airport codes (IATA preferred); [null, null] = looked up, unknown. */
export type Route = [string | null, string | null];

/** One end of a route, with enough to work out distances and look up its weather. */
export type RouteAirport = {
  /** What the card shows: IATA if there is one, else ICAO. */
  code: string;
  /** ICAO code (weather reports are filed under it), if known. */
  icao: string | null;
  name: string | null;
  city: string | null;
  lat: number;
  lon: number;
};
export type RouteInfo = { origin: RouteAirport; destination: RouteAirport };

/** Aircraft from one successful adsb.lol response, when it was fetched (Date.now() ms), and its size. */
type PointData = { ac: RawAircraft[]; fetchedAt: number; /** Response body length (JSON characters). */ bytes: number };

const pointCache = new TTLCache<PointData>(POINT_TTL_MS);
const routeCache = new TTLCache<Route>(ROUTE_TTL_MS);
/** The airports behind each known route (only for callsigns whose route was found and plausible). */
const routeInfoCache = new TTLCache<RouteInfo>(ROUTE_TTL_MS);
/**
 * Most recent successful response per radius: shown instead of an empty sky when upstream fails.
 * Per radius so the 250 nm list never falls back to the small AR query, or the other way round.
 */
const lastGood = new Map<number, PointData>();

export type PointResult = PointData & {
  /** null = fresh data; otherwise why cached/last-good data was returned. fetchedAt says how old it is. */
  problem: null | 'rate-limited' | 'unreachable';
};

async function request(url: string, init: RequestInit = {}): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${TIMEOUT_MS} ms`)), TIMEOUT_MS);
  });
  const headers = { 'User-Agent': USER_AGENT, ...(init.headers as Record<string, string> | undefined) };
  try {
    return await Promise.race([fetch(url, { ...init, headers }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function retryAfterMs(r: Response): number {
  const s = Number(r.headers.get('retry-after') ?? RATE_LIMIT_BACKOFF_MS / 1000);
  return Number.isFinite(s) ? Math.max(1, Math.min(60, s)) * 1000 : RATE_LIMIT_BACKOFF_MS;
}

/**
 * Where live positions are asked for, in order of preference. Both serve the same readsb format
 * (compared 2026-11-20: positions within about 100 m of each other, callsigns identical).
 *
 * adsb.lol comes first; adsb.fi is only asked when adsb.lol has just refused or failed. Without a
 * second source, a rate limit right after the app starts (nothing cached yet) meant an empty sky
 * until adsb.lol relented: seen on the phone on 2026-11-21, after a night of restarts.
 */
const SOURCES: { name: string; url: (lat: string, lon: string, nm: number) => string; cooldownUntil: number }[] = [
  { name: 'adsb.lol', url: (lat, lon, nm) => `${ADSB_LOL}/v2/point/${lat}/${lon}/${nm}`, cooldownUntil: 0 },
  { name: 'adsb.fi', url: (lat, lon, nm) => `https://opendata.adsb.fi/api/v3/lat/${lat}/lon/${lon}/dist/${nm}`, cooldownUntil: 0 },
];
/** Which source the latest good answer came from (for the info line). */
let lastSource = SOURCES[0].name;
export const trafficSource = () => lastSource;

/** Raw readsb aircraft within radiusNm. Never throws: falls back to cached / last good data. */
export async function fetchPoint(lat: number, lon: number, radiusNm: number): Promise<PointResult> {
  const nm = Math.max(1, Math.min(MAX_RADIUS_NM, Math.round(radiusNm)));
  const qlat = lat.toFixed(KEY_DECIMALS);
  const qlon = lon.toFixed(KEY_DECIMALS);
  const key = `${qlat},${qlon},${nm}`;
  const cached = pointCache.get(key);
  if (cached) return { ...cached, problem: null };
  const fallback = pointCache.getStale(key) ?? lastGood.get(nm) ?? { ac: [], fetchedAt: Date.now(), bytes: 0 };
  let problem: PointResult['problem'] = 'unreachable';
  for (const source of SOURCES) {
    if (Date.now() < source.cooldownUntil) {
      problem = 'rate-limited';
      continue;
    }
    try {
      const r = await request(source.url(Number(qlat).toFixed(4), Number(qlon).toFixed(4), nm));
      if (r.status === 429) {
        const wait = retryAfterMs(r);
        source.cooldownUntil = Date.now() + wait;
        console.warn(`${source.name} rate limited (429); backing off ${wait / 1000} s`);
        problem = 'rate-limited';
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      const body = JSON.parse(text) as { ac?: RawAircraft[] | null };
      const data: PointData = { ac: body.ac ?? [], fetchedAt: Date.now(), bytes: text.length };
      pointCache.set(key, data);
      lastGood.set(nm, data);
      if (source.name !== lastSource) console.info(`[traffic] positions now from ${source.name}`);
      lastSource = source.name;
      return { ...data, problem: null };
    } catch (e) {
      console.warn(`${source.name} point fetch failed:`, e);
    }
  }
  return { ...fallback, problem };
}

type Airport = {
  lat?: number | null;
  lon?: number | null;
  iata?: string | null;
  icao?: string | null;
  name?: string | null;
  location?: string | null;
};
type RouteEntry = { callsign?: string; plausible?: unknown; _airports?: Airport[] | null };

/** How far off a leg a plane can be and still plausibly be flying it (vectors, holds, weather). */
const ROUTE_SLACK_KM = 120;
const ROUTE_SLACK_FRACTION = 0.25;

/**
 * Origin/destination from a route entry. Multi-leg routes pick the leg the plane is on. Entries from
 * the old batch service carry `plausible`; the static files don't, so plausibility is judged here
 * from the plane's position (the files can be stale: a callsign reused for another city pair).
 */
export function parseRoute(entry: RouteEntry, lat?: number, lon?: number): Route {
  const info = parseRouteInfo(entry, lat, lon);
  return info ? [info.origin.code, info.destination.code] : [null, null];
}

/** As parseRoute, with the two airports' details. null = no usable route. */
export function parseRouteInfo(entry: RouteEntry, lat?: number, lon?: number): RouteInfo | null {
  const found = pickLeg(entry, lat, lon);
  if (!found) return null;
  const describe = (a: Airport & { lat: number; lon: number }): RouteAirport => ({
    code: (a.iata || a.icao)!,
    icao: a.icao || null,
    name: a.name || null,
    city: a.location || null,
    lat: a.lat,
    lon: a.lon,
  });
  return { origin: describe(found[0]), destination: describe(found[1]) };
}

type LocatedAirport = Airport & { lat: number; lon: number };

/** The two airports of the leg the plane is on, or null. */
function pickLeg(entry: RouteEntry, lat?: number, lon?: number): [LocatedAirport, LocatedAirport] | null {
  if (entry.plausible != null && !entry.plausible) return null;
  const airports = (entry._airports ?? []).filter((a): a is LocatedAirport => a.lat != null && a.lon != null);
  const codes = airports.map((a) => a.iata || a.icao || null);
  if (airports.length < 2 || !codes.every(Boolean)) return null;
  if (lat == null || lon == null) return [airports[0], airports[1]];
  // Detour of flying leg i via the plane's position, and the leg's own length.
  const leg = (i: number) => {
    const [a, b] = [airports[i], airports[i + 1]];
    const direct = haversineKm(a.lat, a.lon, b.lat, b.lon);
    return { detour: haversineKm(a.lat, a.lon, lat, lon) + haversineKm(lat, lon, b.lat, b.lon) - direct, direct };
  };
  // Multi-leg (e.g. ATL-MIA-ATL): pick the leg with the smallest detour.
  let best = 0;
  for (let i = 1; i < airports.length - 1; i++) if (leg(i).detour < leg(best).detour) best = i;
  if (entry.plausible == null) {
    const { detour, direct } = leg(best);
    if (detour > ROUTE_SLACK_KM + ROUTE_SLACK_FRACTION * direct) return null;
  }
  return [airports[best], airports[best + 1]];
}

/** Cached route for a callsign, or undefined if it hasn't been looked up (or the entry expired). */
export const cachedRoute = (callsign: string): Route | undefined => routeCache.get(callsign);
/**
 * True when this plane has no route and none is coming: its callsign isn't an airline's (a tail
 * number, as on nearly every small plane), or it was looked up and nothing was found.
 */
export function hasNoRoute(callsign: string | null): boolean {
  if (!callsign || !ROUTABLE.test(callsign)) return true;
  const route = routeCache.get(callsign);
  return !!route && !route[0] && !route[1];
}
/** The airports of a callsign's route, if it has a known one. */
export const cachedRouteInfo = (callsign: string): RouteInfo | undefined => routeInfoCache.get(callsign);

/**
 * Looks up routes for these planes' callsigns that aren't cached yet, and fills the cache. One small
 * GET per callsign, a few at a time. Best effort, never throws. Callers pass only the planes they
 * actually need routes for (the AR view's planes, or one plane opened from the list): never the
 * whole 250 nm set.
 */
export async function lookupRoutes(planes: Plane[]): Promise<void> {
  const queue: Plane[] = [];
  const seen = new Set<string>();
  for (const p of planes) {
    const cs = p.callsign;
    if (!cs || seen.has(cs) || !ROUTABLE.test(cs) || routeCache.get(cs)) continue;
    seen.add(cs);
    queue.push(p);
    if (queue.length >= MAX_ROUTE_LOOKUPS) break;
  }
  const worker = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) await lookupRoute(p);
  };
  await Promise.all(Array.from({ length: Math.min(ROUTE_CONCURRENCY, queue.length) }, worker));
}

async function lookupRoute(p: Plane): Promise<void> {
  const cs = p.callsign!;
  try {
    const r = await request(`${ROUTE_FILES}/${cs.slice(0, 2)}/${cs}.json`);
    if (r.status === 404) {
      routeCache.set(cs, [null, null]); // no such flight in the data: don't ask again for a while
      return;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const info = parseRouteInfo((await r.json()) as RouteEntry, p.lat, p.lon);
    routeCache.set(cs, info ? [info.origin.code, info.destination.code] : [null, null]);
    if (info) routeInfoCache.set(cs, info);
  } catch (e) {
    console.warn(`route lookup failed for ${cs}:`, e);
    routeCache.set(cs, [null, null], ROUTE_MISS_TTL_MS);
  }
}
