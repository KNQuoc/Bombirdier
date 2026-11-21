// The airport as the HUD wants it: runways and the active pattern as bearing/distance from where
// you're standing (the HUD knows nothing about latitude and longitude).

import type { AirportOverlay, RadarPoint } from '@web/hud';
import type { LatLon } from '@web/planes';
import type { Airport } from '../airports/airport';
import { mslFtToEllipsoidM, runwayEnd } from '../airports/airport';
import { bearingAndDistance, buildPattern, densify } from './geometry';

/** Beyond this the airport is left off the HUD altogether. */
export const AIRPORT_SHOWN_WITHIN_KM = 40;
/** Closer than this, the radar zooms in on the pattern instead of fitting the farthest plane. */
const PATTERN_RADAR_WITHIN_KM = 10;
/** Room for the whole pattern around the field on the radar. */
const PATTERN_REACH_KM = 3.4;
const PATTERN_RADAR_RANGES_KM = [5, 10, 15];
/** Sky line sample spacing. */
const SKY_STEP_M = 150;
/** Standing still, GPS wanders by a few meters: don't redo the geometry for that. */
const MOVED_M = 5;

export type AirportView = {
  overlay: Omit<AirportOverlay, 'legCodes'>;
  distanceKm: number;
  /** Radar range that shows the pattern, or null when you're too far away for that to make sense. */
  patternRadarKm: number | null;
};

/** Returns a function of your position; results are cached until you move or the runway changes. */
export function createAirportView(airport: Airport): (viewer: LatLon, runwayIdent: string) => AirportView | null {
  let cache: { at: LatLon; runway: string; view: AirportView | null } | null = null;

  return (viewer, runwayIdent) => {
    if (cache && cache.runway === runwayIdent && bearingAndDistance(cache.at, viewer).distanceKm * 1000 < MOVED_M) {
      return cache.view;
    }
    const { distanceKm } = bearingAndDistance(viewer, airport.position);
    let view: AirportView | null = null;
    if (distanceKm <= AIRPORT_SHOWN_WITHIN_KM) {
      const pattern = buildPattern(airport, runwayIdent);
      const seen = (p: LatLon): RadarPoint => bearingAndDistance(viewer, p);
      // Each pavement once (10/28 and 18/36), not once per end.
      const pavements = airport.runways.filter((r) => r.ident < r.oppositeIdent);
      view = {
        distanceKm,
        patternRadarKm:
          distanceKm <= PATTERN_RADAR_WITHIN_KM
            ? (PATTERN_RADAR_RANGES_KM.find((km) => km >= distanceKm + PATTERN_REACH_KM) ?? null)
            : null,
        overlay: {
          runways: pavements.map((r) => [seen(r.threshold), seen(runwayEnd(airport, r.oppositeIdent).threshold)]),
          pattern: pattern.legs.flatMap((l, i) => (i === 0 ? l.points : l.points.slice(1))).map(seen),
          skyPattern: pattern.legs
            .flatMap((l, i) => (i === 0 ? densify(l.points, SKY_STEP_M) : densify(l.points, SKY_STEP_M).slice(1)))
            .map((p) => ({ ...seen(p), altM: mslFtToEllipsoidM(airport, p.altFtMsl) })),
        },
      };
    }
    cache = { at: viewer, runway: runwayIdent, view };
    return view;
  };
}
