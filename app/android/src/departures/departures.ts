// Where a plane left from, worked out by watching it.
//
// Small planes mostly file no flight plan (flying visually needs none in the US), so there is no
// route to look up for a Cessna. But the app watches every plane within 250 nm, and a plane that
// stood on an airfield and then flew off has left from it. That is remembered here and shown on
// the plane's card for planes with no route on file.
//
//   from      it stopped there (taxied, parked, or stayed several minutes), then left. Or, from
//             the Mac: OpenSky's track of the flight starts on that field.  "From Wood County · 25 min ago"
//   near      from the Mac: the track starts close to that field.            "From near Findlay · 1 h ago"
//   leaving   the app saw it climb away from there, but not stop: a touch-and-go, a low approach,
//             or a plane first seen already climbing out. Where it started is not known.
//                                                                            "Seen leaving Marion · 5 min ago"
//
// A touch-and-go does not replace a known "from": a trainer that left Wood County and bounces at
// Findlay is still from Wood County. Only what was seen while the app was running is known; for
// the rest main.ts asks the Mac (set()) about the plane being looked at.

import type { Plane } from '@web/planes';
import { signedDiffDeg } from '@web/geo';
import { bearingDeg, haversineKm } from '../flights/geo';
import { nearestAirfield, shortName } from '../airports/lookup';
import type { Airfield, Nearest, NearAirfield } from '../airports/lookup';

export type Departure = {
  field: Pick<Airfield, 'code' | 'name' | 'city' | 'kind' | 'lat' | 'lon'>;
  /** When it left (the last moment it was seen there, or worked out from distance and speed). */
  atMs: number;
  how: 'from' | 'near' | 'leaving';
  source: 'seen' | 'opensky';
};

/** A position older than this says nothing about where the plane is now. */
const STALE_POSITION_S = 90;
/** How far from the airfield's reference point a plane on the ground can be: big airports are big. */
const ON_GROUND_NM = { L: 3, M: 3, S: 1.5, P: 0.7, H: 0.7 } as const;
/** In the air but still "at the field": this low above it and this close (public airports). */
const LOW_OVER_FIELD_FT = 600;
const LOW_OVER_FIELD_NM = { L: 2.5, M: 2.5, S: 1.5 } as const;
/** A private strip or heliport counts from the air only when hovering or crawling right over it. */
const LOW_OVER_STRIP_FT = 300;
const LOW_OVER_STRIP_NM = 0.5;
const LOW_OVER_STRIP_KT = 60;
/**
 * It stopped there, rather than touched and went: seen at the field slower than any plane flies
 * (taxiing, parked), or there for longer than a touch-and-go takes however it is sampled.
 */
const STOPPED_BELOW_KT = 30;
const STOPPED_AFTER_MS = 4 * 60_000;
/** Leaving a field it never stopped at counts when it is climbing (a landing carried past the runway between reports is not). */
const LEAVING_CLIMB_FPM = 200;
/** First seen climbing away: within this far and this high above a public airport, moving away from it. */
const CLIMB_OUT_NM = 5;
const CLIMB_OUT_FT = 2000;
const CLIMB_OUT_FPM = 300;
const CLIMB_OUT_AWAY_DEG = 60;
/** After this long the line says nothing useful any more. */
const SHOW_FOR_MS = 8 * 3600_000;
/** A plane not seen for this long is forgotten. */
const FORGET_AFTER_MS = 2 * 3600_000;
const M_PER_FT = 0.3048;
const KM_PER_NM = 1.852;

type Track = {
  /** The field it is at now. */
  at: NearAirfield | null;
  /** When this stay at the field began, and the last moment it was seen there. */
  sinceMs: number;
  atMs: number;
  /** It has stopped during this stay (see STOPPED_*). */
  stopped: boolean;
  left: Departure | null;
  lastSeenMs: number;
};

export type Departures = ReturnType<typeof createDepartures>;

export function createDepartures(opts: { nearest?: Nearest; geoidSeparationM?: number } = {}) {
  const nearest = opts.nearest ?? nearestAirfield;
  // ADS-B's GPS altitude is height above the ellipsoid; airfield elevations are above sea level.
  const geoidFt = (opts.geoidSeparationM ?? -34) / M_PER_FT;
  const tracks = new Map<string, Track>();
  const blank = (nowMs: number): Track => ({ at: null, sinceMs: 0, atMs: 0, stopped: false, left: null, lastSeenMs: nowMs });

  /** Feet above sea level: GPS altitude when the plane sends it (barometric is off with the weather). */
  const mslFt = (p: Plane) => (p.altitudeGeomFt != null ? p.altitudeGeomFt - geoidFt : p.altitudeFt);

  /** The airfield this plane is at right now, or null. */
  function fieldUnder(p: Plane): NearAirfield | null {
    const field = nearest(p.lat, p.lon, { maxNm: 3, helicopter: p.kind === 'helicopter' });
    if (!field) return null;
    if (p.onGround) return field.distanceNm <= ON_GROUND_NM[field.kind] ? field : null;
    const alt = mslFt(p);
    if (alt == null || field.elevationFt == null) return null;
    const above = alt - field.elevationFt;
    if (field.kind === 'P' || field.kind === 'H') {
      return above <= LOW_OVER_STRIP_FT && field.distanceNm <= LOW_OVER_STRIP_NM && (p.groundSpeedKt ?? Infinity) <= LOW_OVER_STRIP_KT ? field : null;
    }
    return above <= LOW_OVER_FIELD_FT && field.distanceNm <= LOW_OVER_FIELD_NM[field.kind] ? field : null;
  }

  /** A plane seen for the first time, low and climbing away from a public airport close behind it. */
  function climbingOutOf(p: Plane, nowMs: number): Departure | null {
    if (p.onGround || p.trackDeg == null || !p.groundSpeedKt || p.groundSpeedKt < 40) return null;
    if ((p.verticalRateFpm ?? 0) < CLIMB_OUT_FPM) return null;
    const field = nearest(p.lat, p.lon, { maxNm: CLIMB_OUT_NM, publicOnly: true });
    const alt = mslFt(p);
    if (!field || alt == null || field.elevationFt == null || alt - field.elevationFt > CLIMB_OUT_FT) return null;
    const away = bearingDeg(field.lat, field.lon, p.lat, p.lon);
    if (Math.abs(signedDiffDeg(p.trackDeg, away)) > CLIMB_OUT_AWAY_DEG) return null;
    const sinceMs = (field.distanceNm / p.groundSpeedKt) * 3600_000;
    return { field, atMs: nowMs - sinceMs, how: 'leaving', source: 'seen' };
  }

  const ago = (min: number) => {
    if (min < 1.5) return 'just now';
    if (min < 60) return `${Math.round(min)} min ago`;
    const h = Math.floor(min / 60);
    const m = Math.round(min - h * 60);
    return m ? `${h} h ${m} min ago` : `${h} h ago`;
  };

  const LEAD = { from: 'From', near: 'From near', leaving: 'Seen leaving' } as const;
  const words = (left: Departure, nowMs: number) => `${LEAD[left.how]} ${shortName(left.field)} · ${ago((nowMs - left.atMs) / 60_000)}`;

  /** Where it left from, unless it has stopped somewhere since (then it is there, not from anywhere). */
  const current = (id: string, nowMs: number): Departure | null => {
    const t = tracks.get(id);
    if (!t?.left || (t.at && t.stopped)) return null;
    return nowMs - t.left.atMs <= SHOW_FOR_MS ? t.left : null;
  };

  return {
    /** Feed it every known plane (near and wide), every second or two. */
    update(planes: Plane[], nowMs: number) {
      for (const p of planes) {
        const ageMs = (p.positionAgeS ?? 0) * 1000;
        if (ageMs > STALE_POSITION_S * 1000) continue;
        const seenMs = nowMs - ageMs;
        let t = tracks.get(p.id);
        const first = !t;
        if (!t) tracks.set(p.id, (t = blank(nowMs)));
        t.lastSeenMs = nowMs;
        const here = fieldUnder(p);
        if (here) {
          if (t.at?.code !== here.code) {
            t.sinceMs = seenMs;
            t.stopped = false;
          }
          t.at = here;
          t.atMs = seenMs;
          t.stopped ||= (p.groundSpeedKt != null && p.groundSpeedKt < STOPPED_BELOW_KT) || seenMs - t.sinceMs >= STOPPED_AFTER_MS;
        } else if (p.onGround) {
          // Rolling or taxiing somewhere the list doesn't reach: on the ground is not a departure.
        } else if (t.at) {
          // Away from the field it was at. The time: no earlier than it was last seen there, and
          // later if that was a while ago and it is still close (it sat with its transponder off).
          const flownMs = p.groundSpeedKt ? (haversineKm(t.at.lat, t.at.lon, p.lat, p.lon) / KM_PER_NM / p.groundSpeedKt) * 3600_000 : Infinity;
          const atMs = Math.max(t.atMs, seenMs - flownMs);
          if (t.stopped || seenMs - t.sinceMs >= STOPPED_AFTER_MS) {
            t.left = { field: t.at, atMs, how: 'from', source: 'seen' };
          } else if ((p.verticalRateFpm ?? 0) >= LEAVING_CLIMB_FPM && (!t.left || t.left.how === 'leaving')) {
            // A touch-and-go or a low approach: it left, but where it started is still unknown.
            t.left = { field: t.at, atMs, how: 'leaving', source: 'seen' };
          }
          t.at = null;
          t.stopped = false;
        } else if (first) {
          t.left = climbingOutOf(p, seenMs);
        }
      }
      for (const [id, t] of tracks) if (nowMs - t.lastSeenMs > FORGET_AFTER_MS) tracks.delete(id);
    },
    /** Where this plane left from, if that is known. */
    of: current,
    /** The airfield this plane is at right now, if any. */
    at: (id: string): NearAirfield | null => tracks.get(id)?.at ?? null,
    /**
     * What the Mac found (the start of OpenSky's track): the flight's real start, so it replaces a
     * "leaving" sighting, but never a stop the app saw itself.
     */
    set(id: string, departure: Departure, nowMs: number) {
      const t = tracks.get(id) ?? blank(nowMs);
      if (t.left?.how === 'from' && t.left.source === 'seen') return;
      t.left = departure;
      tracks.set(id, t);
    },
    /** The card line: "From Wood County · 25 min ago", "Seen leaving Marion · 5 min ago". */
    line(id: string, nowMs: number): string | null {
      const left = current(id, nowMs);
      return left ? words(left, nowMs) : null;
    },
    /** Every plane with a known departure, as its card line (for looking at from a console). */
    known(nowMs: number) {
      const out: { id: string; line: string; source: string }[] = [];
      for (const id of tracks.keys()) {
        const left = current(id, nowMs);
        if (left) out.push({ id, line: words(left, nowMs), source: left.source });
      }
      return out;
    },
    /** For the voice assistant: the same fact, so what is said matches the card. */
    brief(id: string, nowMs: number) {
      const left = current(id, nowMs);
      if (!left) return null;
      const { code, name, city, kind, lat, lon } = left.field;
      return { code, name, city, kind, lat, lon, agoMin: Math.round(((nowMs - left.atMs) / 60_000) * 10) / 10, how: left.how };
    },
  };
}
