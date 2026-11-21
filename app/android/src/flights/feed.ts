// Live plane feed for the HUD: same PlaneFeed/FeedState interface as web/src/planes.ts, but the
// data comes from the in-app engine (nearby.ts) instead of flight-service. (No demo mode: the app
// always shows live traffic around the phone's GPS position.)

import type { Plane } from '@web/planes';
import type { FeedState, LatLon, PlaneFeed } from '@web/planes';
import { toRad } from '@web/geo';
import { bearingDeg, haversineKm } from './geo';
import { problemText, trafficSource } from './adsb';
import type { PointResult } from './adsb';
import { livePlanes } from './nearby';

/**
 * adsb.lol rate-limits per IP, and the limit varies. Measured on a Galaxy S22+ (2026-09-29):
 * a fixed 1 s poll got 11 of 13 requests rejected (429), and a fixed 5 s poll still got 7 of 12.
 * A throttled client also gets slow answers (seconds) before any 429. So the poll interval adapts:
 * ×1.5 after a 429, a failure or a slow answer; −1 s after a quick success; within these bounds.
 * That settles near the rate adsb.lol currently allows, including with several phones behind one IP.
 */
const MIN_POLL_MS = 5000;
/** Above this radius each answer is several times bigger, so the feed asks a little less often. */
const BIG_RADIUS_KM = 100;
const BIG_RADIUS_MIN_POLL_MS = 8000;
const MAX_POLL_MS = 30_000;
/** An answer slower than this means adsb.lol is throttling us: back off like on a 429. */
const SLOW_ANSWER_MS = 3000;
/** How often to check for the first GPS fix. */
const GPS_WAIT_POLL_MS = 1000;

/**
 * Between polls, airborne planes are moved along their track (dead reckoning), for at most this long
 * after their position was actually received. The age of the position counts, not just the time
 * since the fetch: a plane that has dropped out of coverage (landing, behind terrain) keeps coming
 * back from adsb.lol with the same old position, and must not be flown on from it again each poll.
 */
const MAX_EXTRAPOLATE_S = 60;
/** Climb and descent rates change quickly: altitude is carried forward for less time than position. */
const MAX_ALTITUDE_EXTRAPOLATE_S = 20;
/** Recompute extrapolated positions at most this often (get() is called every frame). */
const EXTRAPOLATE_EVERY_MS = 100;
const KM_PER_DEG_LAT = 111.32;
const KM_PER_NM = 1.852;

/**
 * Where each plane is now: moved from its reported position along trackDeg at groundSpeedKt for the
 * time since the data was fetched, with distance/bearing recomputed from the viewer's position.
 * Planes on the ground or without speed/track stay put. Flat-earth step: fine for < ~15 km moves.
 */
export function extrapolate(planes: Plane[], fetchedAt: number, now: number, viewer: LatLon): Plane[] {
  const sinceFetchS = Math.max(0, (now - fetchedAt) / 1000);
  return planes.map((p) => {
    const ageS = sinceFetchS + Math.max(0, p.positionAgeS ?? 0);
    const hours = Math.min(MAX_EXTRAPOLATE_S, ageS) / 3600;
    let { lat, lon, altitudeFt, altitudeGeomFt } = p;
    if (!p.onGround && p.groundSpeedKt && p.trackDeg != null) {
      const km = p.groundSpeedKt * KM_PER_NM * hours;
      const t = toRad(p.trackDeg);
      lat += (km * Math.cos(t)) / KM_PER_DEG_LAT;
      lon += (km * Math.sin(t)) / (KM_PER_DEG_LAT * Math.cos(toRad(lat)));
    }
    // Climb/descend too, so the sky marker stays on the plane between polls (a 1,800 fpm descent
    // is ~900 ft in a 30 s gap). Never below 0.
    if (!p.onGround && p.verticalRateFpm) {
      const ft = (p.verticalRateFpm * Math.min(MAX_ALTITUDE_EXTRAPOLATE_S, ageS)) / 60;
      if (altitudeFt != null) altitudeFt = Math.max(0, altitudeFt + ft);
      if (altitudeGeomFt != null) altitudeGeomFt = Math.max(0, altitudeGeomFt + ft);
    }
    return {
      ...p,
      lat,
      lon,
      altitudeFt,
      altitudeGeomFt,
      distanceKm: haversineKm(viewer.lat, viewer.lon, lat, lon),
      bearingDeg: bearingDeg(viewer.lat, viewer.lon, lat, lon),
    };
  });
}

/** The AR view's feed. `throttled` lets the 250 nm poller stay out of the way (one rate limit for both). */
export type NearFeed = PlaneFeed & {
  /** True if the latest poll was rate-limited, failed or slow. */
  throttled: () => boolean;
  /** What was wrong with the latest poll, or null: the wide poller reports the same reason. */
  problem: () => PointResult['problem'] | 'slow';
  /** Changes how far out planes are asked for, and asks again right away. null = the default. */
  setRadius: (radiusKm: number | null) => void;
};

/**
 * Polls adsb.lol around the GPS position with an adaptive interval (see MIN_POLL_MS), starting each
 * poll after the previous one finishes so slow responses never pile up. On failure it keeps the
 * last good data. Positions are extrapolated between polls so planes glide instead of jumping.
 */
export function startLiveFeed(opts: { radiusKm: number | null; getPosition: () => LatLon | null }): NearFeed {
  let radiusKm = opts.radiusKm;
  /** Goes up when the radius changes, so an answer for the old radius that is still on its way is dropped. */
  let generation = 0;
  let status = 'live · waiting for GPS';
  let polled: { planes: Plane[]; fetchedAt: number; at: LatLon } | null = null;
  let current: FeedState = { planes: [], status };
  let computedAt = 0;
  let interval = MIN_POLL_MS;
  let lastThrottled = false;
  let lastProblem: PointResult['problem'] | 'slow' = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function poll() {
    const pos = opts.getPosition();
    if (!pos) {
      // No fix yet: check again soon so planes appear as soon as GPS locks (no network call here).
      status = 'live · waiting for GPS';
      if (!stopped) timer = setTimeout(poll, GPS_WAIT_POLL_MS);
      return;
    }
    const startedAt = Date.now();
    const mine = generation;
    const { planes, problem, fetchedAt } = await livePlanes(pos.lat, pos.lon, radiusKm);
    if (stopped || mine !== generation) return;
    polled = { planes, fetchedAt, at: pos };
    computedAt = 0; // recompute on the next get()
    const throttled = problem != null || Date.now() - startedAt > SLOW_ANSWER_MS;
    lastThrottled = throttled;
    lastProblem = problem ?? (throttled ? 'slow' : null);
    const fastest = (radiusKm ?? 0) > BIG_RADIUS_KM ? BIG_RADIUS_MIN_POLL_MS : MIN_POLL_MS;
    interval = throttled ? Math.min(MAX_POLL_MS, interval * 1.5) : Math.max(fastest, interval - 1000);
    const age = Math.round((Date.now() - fetchedAt) / 1000);
    status = problem
      ? `live · ${problem === 'rate-limited' ? 'rate limited by both sources' : problemText(problem)} · ${planes.length} cached (${age} s old)`
      : `live${trafficSource() === 'adsb.lol' ? '' : ` (${trafficSource()})`} · ${planes.length} planes`;
    status += ` · every ${Math.round(interval / 1000)} s`;
    timer = setTimeout(poll, interval);
  }

  poll();
  return {
    get: () => {
      const now = Date.now();
      if (now - computedAt >= EXTRAPOLATE_EVERY_MS) {
        computedAt = now;
        const planes = polled ? extrapolate(polled.planes, polled.fetchedAt, now, opts.getPosition() ?? polled.at) : [];
        current = { planes, status };
      }
      return current;
    },
    throttled: () => lastThrottled,
    problem: () => lastProblem,
    setRadius: (km) => {
      if (km === radiusKm || stopped) return;
      radiusKm = km;
      generation++;
      clearTimeout(timer);
      void poll();
    },
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
