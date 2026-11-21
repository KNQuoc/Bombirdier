// Which runway the wind favors. Pilots land and take off into the wind, so when no traffic has
// shown which runway is in use (runway.ts), the wind is the next best thing to go by.
//
// The wind comes from the nearest airport weather report (the Mac asks aviationweather.gov; Wood
// County has no weather station of its own, so it is Toledo Executive's or Findlay's, a few miles
// away). Wind directions in those reports are true, like the runway headings here.

import type { Airport } from '../airports/airport';

/** Below this the wind doesn't decide anything: the airport's calm-wind runway is used. */
export const CALM_KT = 4;
/** A report older than this is no longer "the wind". */
export const WIND_GOOD_FOR_MS = 90 * 60_000;

export type Wind = {
  /** Where it's from, degrees true. null = variable. */
  dirDeg: number | null;
  speedKt: number;
  gustKt: number | null;
  /** "Toledo Executive" */
  station: string;
  distanceNm: number | null;
  /** When the phone got it. */
  at: number;
};

export type WindRunway = {
  ident: string;
  headwindKt: number;
  /** Always positive. */
  crosswindKt: number;
};

/** The runway end most into the wind, or null when the wind is calm or variable (no preference). */
export function runwayForWind(airport: Airport, wind: Pick<Wind, 'dirDeg' | 'speedKt'>): WindRunway | null {
  if (wind.dirDeg == null || wind.speedKt < CALM_KT) return null;
  let best: WindRunway | null = null;
  for (const r of airport.runways) {
    const angle = ((wind.dirDeg - r.headingTrue) * Math.PI) / 180;
    const headwindKt = wind.speedKt * Math.cos(angle);
    if (!best || headwindKt > best.headwindKt) best = { ident: r.ident, headwindKt, crosswindKt: Math.abs(wind.speedKt * Math.sin(angle)) };
  }
  return best;
}

/** "190 at 8" / "190 at 8 gusting 15": the wind the way it's said. */
export function windWords(wind: Pick<Wind, 'dirDeg' | 'speedKt' | 'gustKt'>): string {
  if (wind.speedKt < 1) return 'calm';
  const from = wind.dirDeg == null ? 'variable' : String(Math.round(wind.dirDeg / 10) * 10 || 360).padStart(3, '0');
  return `${from} at ${Math.round(wind.speedKt)}${wind.gustKt ? ` gusting ${Math.round(wind.gustKt)}` : ''}`;
}
