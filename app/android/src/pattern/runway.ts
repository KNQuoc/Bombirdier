// Which runway is in use? Worked out from what the traffic is doing, so nobody has to set it.
//
// The first live landing the app saw (a BGSU Seminole on runway 18, 2026-11-21) was labeled wrong
// from start to finish because the runway setting said 28. A plane's own path gives it away:
//   - lined up low on final, or climbing out over the runway: that runway, no question ("strong")
//   - level at pattern altitude on a downwind: each of the four runway ends has its own downwind
//     (side of the field + direction), so that says it too, a couple of minutes earlier ("weak":
//     a plane just passing by on that line looks the same)
// Strong evidence replaces anything. Weak evidence only sets the runway when there is no recent
// strong evidence for another one.

import type { Plane } from '@web/planes';
import type { Airport } from '../airports/airport';
import { altitudeMslFt, classify } from './classify';

/** Looked at this often, like the leg tracker. */
const CHECK_MS = 2000;
/** The same answer this many checks in a row before it counts. */
const STRONG_CHECKS = 2;
const WEAK_CHECKS = 3;
const STRONG_CONFIDENCE = 0.8;
const WEAK_CONFIDENCE = 0.85;
/** Pressure altitude can read a few hundred feet off, so "at or below pattern altitude" gets a margin. */
const ALTITUDE_MARGIN_FT = 500;
/** How close to pattern altitude a downwind has to be flown to count. */
const DOWNWIND_BAND_FT = 500;
/** A landing or takeoff keeps deciding the runway for this long, whatever passes by on a downwind line. */
const STRONG_HOLDS_MS = 20 * 60_000;

export type RunwayInUse = {
  ident: string;
  /** The plane that showed it. */
  by: string;
  /** From a landing or takeoff (true) or from a downwind leg (false). */
  strong: boolean;
  at: number;
};

export function createRunwayDetector(airport: Airport) {
  const streaks = new Map<string, { ident: string; strong: boolean; count: number }>();
  let current: RunwayInUse | null = null;
  let lastCheck = -Infinity;

  /** What one plane says about the runway right now, if anything. */
  function evidence(p: Plane): { ident: string; strong: boolean } | null {
    const alt = altitudeMslFt(p, airport);
    if (alt == null) return null;
    let weak: string | null = null;
    for (const end of airport.runways) {
      const { leg, confidence } = classify(p, airport, end.ident);
      if ((leg === 'final' || leg === 'upwind') && confidence >= STRONG_CONFIDENCE && alt <= airport.tpaFtMsl + ALTITUDE_MARGIN_FT) {
        return { ident: end.ident, strong: true };
      }
      if (leg === 'downwind' && confidence >= WEAK_CONFIDENCE && Math.abs(alt - airport.tpaFtMsl) <= DOWNWIND_BAND_FT) weak ??= end.ident;
    }
    return weak ? { ident: weak, strong: false } : null;
  }

  return {
    /** Call every frame with the planes near you. Returns the runway in use, or null if nothing has shown it yet. */
    update(planes: Plane[], now: number): RunwayInUse | null {
      if (now - lastCheck < CHECK_MS) return current;
      lastCheck = now;
      const seen = new Set<string>();
      for (const p of planes) {
        const e = evidence(p);
        if (!e) continue;
        seen.add(p.id);
        const s = streaks.get(p.id);
        const streak = s && s.ident === e.ident && s.strong === e.strong ? { ...s, count: s.count + 1 } : { ...e, count: 1 };
        streaks.set(p.id, streak);
        if (streak.count < (e.strong ? STRONG_CHECKS : WEAK_CHECKS)) continue;
        const heldByStrong = current?.strong && current.ident !== e.ident && now - current.at < STRONG_HOLDS_MS;
        if (e.strong || !heldByStrong) {
          const by = p.callsign?.trim() || p.registration || p.id;
          // The same runway confirmed again: keep who first showed it, refresh when.
          current = current && current.ident === e.ident ? { ...current, strong: current.strong || e.strong, at: now } : { ident: e.ident, by, strong: e.strong, at: now };
        }
      }
      for (const id of streaks.keys()) if (!seen.has(id)) streaks.delete(id);
      return current;
    },
    current: () => current,
  };
}
