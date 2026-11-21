// The standard rectangular traffic pattern for a runway, as lines to draw, and the "runway frame"
// the leg classifier works in.
//
// Runway frame, for the runway in use: x runs along the runway in the direction of landing and
// takeoff, with x = 0 at the landing threshold and x = runway length at the departure end. y is
// sideways, positive toward the pattern side. In this frame every pattern looks the same, left or
// right: upwind climbs along +x, crosswind goes +y, downwind runs along -x at y = offset, base
// comes back -y, final flies +x to the threshold.

import { normalizeDeg, signedDiffDeg, toDeg, toRad } from '@web/geo';
import type { LatLon } from '@web/planes';
import type { Airport, RunwayEnd } from '../airports/airport';
import { runwayEnd } from '../airports/airport';

export type Leg = 'upwind' | 'crosswind' | 'downwind' | 'base' | 'final';
export const LEGS: Leg[] = ['upwind', 'crosswind', 'downwind', 'base', 'final'];

const M_PER_NM = 1852;
const M_PER_DEG_LAT = 111_320;

/** Downwind is flown this far to the side of the runway. */
export const PATTERN_OFFSET_M = 0.75 * M_PER_NM;
/** The crosswind and base turns are this far past the runway ends. */
export const PATTERN_EXTENSION_M = 0.75 * M_PER_NM;
/** Heights above the field along the descent: turning base, turning final, crossing the threshold. */
const BASE_TURN_AGL_FT = 800;
const FINAL_TURN_AGL_FT = 500;
const THRESHOLD_AGL_FT = 50;

export type PatternPoint = LatLon & { altFtMsl: number };

export type Pattern = {
  runway: RunwayEnd;
  lengthM: number;
  /** The pavement: landing threshold, then departure end. */
  runwayLine: [LatLon, LatLon];
  /** Each leg as a line, in the order they're flown. Consecutive legs share their corner point. */
  legs: { leg: Leg; points: PatternPoint[] }[];
};

/** Meters east and north of `origin` (flat-earth: fine within a few km of the airport). */
function toLocal(origin: LatLon, p: LatLon): { east: number; north: number } {
  return {
    east: (p.lon - origin.lon) * M_PER_DEG_LAT * Math.cos(toRad(origin.lat)),
    north: (p.lat - origin.lat) * M_PER_DEG_LAT,
  };
}

function fromLocal(origin: LatLon, east: number, north: number): LatLon {
  return {
    lat: origin.lat + north / M_PER_DEG_LAT,
    lon: origin.lon + east / (M_PER_DEG_LAT * Math.cos(toRad(origin.lat))),
  };
}

/** Unit vectors (east, north) of the runway frame's x and y axes. */
function axes(runway: RunwayEnd) {
  const h = toRad(runway.headingTrue);
  const side = toRad(runway.headingTrue + (runway.patternSide === 'right' ? 90 : -90));
  return { x: [Math.sin(h), Math.cos(h)] as const, y: [Math.sin(side), Math.cos(side)] as const };
}

export function runwayLengthM(airport: Airport, runway: RunwayEnd): number {
  const other = runwayEnd(airport, runway.oppositeIdent);
  const d = toLocal(runway.threshold, other.threshold);
  return Math.hypot(d.east, d.north);
}

export type RunwayFrame = {
  /** Meters along the runway from the landing threshold (negative = on the approach side). */
  x: number;
  /** Meters to the side, positive toward the pattern side. */
  y: number;
  /**
   * Direction of travel relative to the runway heading, degrees in (-180, 180]: 0 = with the runway
   * (upwind, final), +90 = toward the pattern side (crosswind), 180 = against it (downwind),
   * -90 = back toward the runway (base). Null if the track is unknown.
   */
  relTrack: number | null;
};

export function toRunwayFrame(pos: LatLon, trackDeg: number | null, runway: RunwayEnd): RunwayFrame {
  const { east, north } = toLocal(runway.threshold, pos);
  const a = axes(runway);
  const rel = trackDeg == null ? null : signedDiffDeg(trackDeg, runway.headingTrue);
  return {
    x: east * a.x[0] + north * a.x[1],
    y: east * a.y[0] + north * a.y[1],
    // Mirror left patterns so "+ = toward the pattern side" holds for both.
    relTrack: rel == null ? null : runway.patternSide === 'right' ? rel : -rel,
  };
}

/** A runway-frame point back to latitude/longitude. */
export function fromRunwayFrame(runway: RunwayEnd, x: number, y: number): LatLon {
  const a = axes(runway);
  return fromLocal(runway.threshold, x * a.x[0] + y * a.y[0], x * a.x[1] + y * a.y[1]);
}

/** Compass direction a leg is flown in, degrees true. */
export function legHeading(runway: RunwayEnd, leg: Leg): number {
  const turn = runway.patternSide === 'right' ? 90 : -90;
  const steps: Record<Leg, number> = { upwind: 0, crosswind: 1, downwind: 2, base: 3, final: 0 };
  return normalizeDeg(runway.headingTrue + steps[leg] * turn);
}

/**
 * The pattern for one runway. Level at pattern altitude from the crosswind turn until abeam the
 * landing threshold, then descending: about 800 ft above the field turning base, 500 ft turning
 * final, 50 ft over the threshold. (Pilots vary; this is the textbook shape.)
 */
export function buildPattern(airport: Airport, runwayIdent: string): Pattern {
  const runway = runwayEnd(airport, runwayIdent);
  const L = runwayLengthM(airport, runway);
  const [w, d] = [PATTERN_OFFSET_M, PATTERN_EXTENSION_M];
  const [field, tpa] = [airport.elevationFt, airport.tpaFtMsl];
  const pt = (x: number, y: number, altFtMsl: number): PatternPoint => ({ ...fromRunwayFrame(runway, x, y), altFtMsl });

  const crosswindTurn = pt(L + d, 0, tpa);
  const downwindStart = pt(L + d, w, tpa);
  const baseTurn = pt(-d, w, field + BASE_TURN_AGL_FT);
  const finalTurn = pt(-d, 0, field + FINAL_TURN_AGL_FT);
  return {
    runway,
    lengthM: L,
    runwayLine: [fromRunwayFrame(runway, 0, 0), fromRunwayFrame(runway, L, 0)],
    legs: [
      // Lifts off around mid-runway and climbs straight ahead.
      { leg: 'upwind', points: [pt(L * 0.4, 0, field), crosswindTurn] },
      { leg: 'crosswind', points: [crosswindTurn, downwindStart] },
      { leg: 'downwind', points: [downwindStart, pt(0, w, tpa), baseTurn] },
      { leg: 'base', points: [baseTurn, finalTurn] },
      { leg: 'final', points: [finalTurn, pt(0, 0, field + THRESHOLD_AGL_FT)] },
    ],
  };
}

/** Points every `stepM` along a line, ends included, with altitude interpolated: for drawing a leg in the sky. */
export function densify(points: PatternPoint[], stepM: number): PatternPoint[] {
  const out: PatternPoint[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const [a, b] = [points[i], points[i + 1]];
    const d = toLocal(a, b);
    const n = Math.max(1, Math.ceil(Math.hypot(d.east, d.north) / stepM));
    for (let k = i === 0 ? 0 : 1; k <= n; k++) {
      const t = k / n;
      out.push({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t, altFtMsl: a.altFtMsl + (b.altFtMsl - a.altFtMsl) * t });
    }
  }
  return out;
}

/** Bearing (degrees true) and distance (km) from `from` to `to`, flat-earth. For points near the airport. */
export function bearingAndDistance(from: LatLon, to: LatLon): { bearingDeg: number; distanceKm: number } {
  const { east, north } = toLocal(from, to);
  return { bearingDeg: normalizeDeg(toDeg(Math.atan2(east, north))), distanceKm: Math.hypot(east, north) / 1000 };
}
