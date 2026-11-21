// Which leg of the traffic pattern is a plane on?
//
// Rules on where the plane is and which way it's going, in the runway frame (see geometry.ts).
// Live data is 5-30 s old and dead-reckoned straight ahead in between, so a single answer is shaky
// around the turns: createPatternTracker() adds hysteresis on top (a new leg has to win twice).
// The numbers below are first guesses to tune against real BGSU traffic at Wood County.

import { signedDiffDeg } from '@web/geo';
import type { Plane } from '@web/planes';
import type { Airport, RunwayEnd } from '../airports/airport';
import { M_PER_FT, runwayEnd } from '../airports/airport';
import { PATTERN_OFFSET_M, bearingAndDistance, runwayLengthM, toRunwayFrame } from './geometry';
import type { Leg } from './geometry';

export type PatternLeg = Leg | 'departure' | 'entry';
export type LegResult = { leg: PatternLeg | null; confidence: number };

const NONE: LegResult = { leg: null, confidence: 0 };

/** Only planes this close to the field, and below pattern altitude plus this margin, are considered. */
const NEAR_FIELD_KM = 6;
const ABOVE_TPA_FT = 700;
/** Altitude readings can sit a little below field elevation (pressure altitude, GPS error). */
const BELOW_FIELD_FT = 300;
/** Slower than this isn't flying a pattern (taxiing with a stuck air/ground flag, a hovering helicopter). */
const MIN_SPEED_KT = 40;
/** A leg is only reported (and shown) at or above this confidence. */
export const MIN_CONFIDENCE = 0.5;

/** How far off the leg's direction a track may be, degrees. The turns between legs fall in the overlap. */
const STRAIGHT_TOL_DEG = 35; // upwind, downwind, final
const CROSS_TOL_DEG = 50; // crosswind, base

/** 1 when dead on, 0 at the edge of the tolerance. */
const fit = (errDeg: number, tolDeg: number) => Math.max(0, 1 - Math.abs(errDeg) / tolDeg);

/** Altitude above mean sea level in feet: GPS altitude if the plane sends it (pressure altitude can be off by hundreds of feet). */
function altitudeMslFt(p: Plane, airport: Airport): number | null {
  if (p.altitudeGeomFt != null) return p.altitudeGeomFt - airport.geoidSeparationM / M_PER_FT;
  return p.altitudeFt;
}

/** One look at one plane, no memory. */
export function classify(p: Plane, airport: Airport, runwayIdent: string): LegResult {
  if (p.onGround || p.kind === 'helicopter' || p.trackDeg == null) return NONE;
  if (p.groundSpeedKt != null && p.groundSpeedKt < MIN_SPEED_KT) return NONE;
  const alt = altitudeMslFt(p, airport);
  if (alt == null || alt > airport.tpaFtMsl + ABOVE_TPA_FT || alt < airport.elevationFt - BELOW_FIELD_FT) return NONE;
  const fromField = bearingAndDistance(airport.position, p);
  if (fromField.distanceKm > NEAR_FIELD_KM) return NONE;

  const runway: RunwayEnd = runwayEnd(airport, runwayIdent);
  const L = runwayLengthM(airport, runway);
  const w = PATTERN_OFFSET_M;
  const { x, y, relTrack } = toRunwayFrame(p, p.trackDeg, runway);
  const rel = relTrack!;
  /** How far the track is from a leg's direction. */
  const off = (legDir: number) => signedDiffDeg(rel, legDir);
  const candidates: LegResult[] = [];
  const add = (leg: PatternLeg, errDeg: number, tolDeg: number, floor: number) => {
    if (Math.abs(errDeg) <= tolDeg) candidates.push({ leg, confidence: floor + (1 - floor) * fit(errDeg, tolDeg) });
  };

  // Lined up with the runway, before the threshold: final. The corridor widens with distance.
  if (x <= 0 && x >= -5500 && Math.abs(y) <= 250 + 0.12 * -x) add('final', off(0), STRAIGHT_TOL_DEG, 0.55);
  // Over the runway or straight out past it: upwind (takeoff, touch-and-go, go-around).
  if (x > 0 && x <= L + 2800 && Math.abs(y) <= 250 + 0.12 * Math.max(0, x - L)) add('upwind', off(0), STRAIGHT_TOL_DEG, 0.55);
  // Past the departure end, heading for the pattern side.
  if (x >= L - 200 && x <= L + 3200 && y >= -150 && y <= w + 700) add('crosswind', off(90), CROSS_TOL_DEG, 0.5);
  // Parallel to the runway on the pattern side, 0.6-2.4 km out, flying against the runway direction.
  if (y >= w - 800 && y <= w + 1000 && x >= -3500 && x <= L + 3500) add('downwind', off(180), STRAIGHT_TOL_DEG, 0.55);
  // On the approach side, coming back toward the runway's centerline.
  if (x >= -3800 && x <= 150 && y >= -150 && y <= w + 1000) add('base', off(-90), CROSS_TOL_DEG, 0.5);
  // Outside the downwind, cutting in at about 45 degrees: the standard pattern entry.
  if (y > w + 300) add('entry', off(-135), 30, 0.55);

  if (candidates.length) return candidates.reduce((a, b) => (b.confidence > a.confidence ? b : a));

  // Not on a leg: arriving or leaving, judged by whether it's flying toward or away from the field.
  const toField = signedDiffDeg(p.trackDeg, fromField.bearingDeg + 180);
  if (fromField.distanceKm >= 2 && Math.abs(toField) <= 50) return { leg: 'entry', confidence: MIN_CONFIDENCE };
  const awayFromField = signedDiffDeg(p.trackDeg, fromField.bearingDeg);
  if (fromField.distanceKm >= 2.5 && Math.abs(awayFromField) <= 50) return { leg: 'departure', confidence: MIN_CONFIDENCE };
  return NONE;
}

/** Legs are re-checked this often (not every frame: positions only really change with new data). */
const CHECK_MS = 2000;
/** A different leg has to come out this many checks in a row before the label switches. */
const SWITCH_AFTER = 2;
const FORGET_AFTER_MS = 60_000;

type Tracked = {
  leg: PatternLeg | null;
  confidence: number;
  /** A different answer waiting to be confirmed; undefined = none. */
  pending?: PatternLeg | null;
  pendingCount: number;
  seenAt: number;
};

export type PatternTracker = {
  /** Call every frame with the planes near you; it only does work every CHECK_MS. */
  update: (planes: Plane[], runwayIdent: string, now: number) => void;
  legOf: (id: string) => { leg: PatternLeg; confidence: number } | null;
};

/** classify() with memory: labels don't flip on one odd reading. */
export function createPatternTracker(airport: Airport): PatternTracker {
  const tracked = new Map<string, Tracked>();
  let lastCheck = -Infinity;
  let lastRunway = '';

  return {
    update(planes, runwayIdent, now) {
      if (runwayIdent !== lastRunway) {
        tracked.clear(); // a different runway means different legs for everyone
        lastRunway = runwayIdent;
        lastCheck = -Infinity;
      }
      if (now - lastCheck < CHECK_MS) return;
      lastCheck = now;
      for (const p of planes) {
        const result = classify(p, airport, runwayIdent);
        const leg = result.confidence >= MIN_CONFIDENCE ? result.leg : null;
        const t = tracked.get(p.id);
        if (!t) {
          // First sighting: nothing to be consistent with yet.
          if (leg) tracked.set(p.id, { leg, confidence: result.confidence, pendingCount: 0, seenAt: now });
          continue;
        }
        t.seenAt = now;
        if (leg === t.leg) {
          t.confidence = result.confidence;
          t.pending = undefined;
          t.pendingCount = 0;
        } else if (t.pending === leg && ++t.pendingCount >= SWITCH_AFTER) {
          t.leg = leg;
          t.confidence = result.confidence;
          t.pending = undefined;
          t.pendingCount = 0;
        } else if (t.pending !== leg) {
          t.pending = leg;
          t.pendingCount = 1;
        }
      }
      for (const [id, t] of tracked) if (now - t.seenAt > FORGET_AFTER_MS) tracked.delete(id);
    },
    legOf(id) {
      const t = tracked.get(id);
      return t?.leg ? { leg: t.leg, confidence: t.confidence } : null;
    },
  };
}

const LEG_WORDS: Record<PatternLeg, string> = {
  upwind: 'Upwind',
  crosswind: 'crosswind',
  downwind: 'downwind',
  base: 'base',
  final: 'Final',
  departure: 'Departing',
  entry: 'Entering the pattern',
};

/** The way a pilot would say it: "Right downwind · RWY 28", "Final · RWY 28". */
export function legLabel(leg: PatternLeg, runway: RunwayEnd): string {
  const sided = leg === 'crosswind' || leg === 'downwind' || leg === 'base';
  const words = sided ? `${runway.patternSide === 'right' ? 'Right' : 'Left'} ${LEG_WORDS[leg]}` : LEG_WORDS[leg];
  return `${words} · RWY ${runway.ident}`;
}

/** Radar-sized code for a leg, or null for the ones the radar doesn't label. */
export function legCode(leg: PatternLeg): string | null {
  return { upwind: 'UW', crosswind: 'XW', downwind: 'DW', base: 'B', final: 'F', departure: null, entry: null }[leg];
}
