// Wood County Regional Airport (1G0), Bowling Green, Ohio: home of the BGSU flight program.
//
// Source: FAA airport data effective 29 October 2026, as published on airnav.com/airport/1G0
// (checked 2026-11-20). Thresholds are the FAA runway-end coordinates. Re-check against the FAA
// Chart Supplement when the data cycle changes: pattern directions and TPA do get revised.
//
// Not modeled: runway 36's 68 ft displaced threshold, and the 160 ft AGL stadium lights 0.6 nm SE.
// Radio (for Phase 5): CTAF/UNICOM 122.975, AWOS 120.725, Toledo Approach/Departure 126.1.

import type { Airport } from './airport';

/** Degrees + decimal minutes -> decimal degrees. */
const dm = (deg: number, min: number) => deg + min / 60;

export const WOOD_COUNTY: Airport = {
  ident: '1G0',
  name: 'Wood County Regional',
  position: { lat: 41.391, lon: -83.6301389 },
  elevationFt: 673,
  tpaFtMsl: 1700,
  // EGM96 geoid height in northwest Ohio.
  geoidSeparationM: -34,
  defaultRunway: '28', // FAA remark: "28 calm wind rwy"
  runways: [
    // 10/28: 4,199 x 75 ft. Both patterns are flown north of the runway.
    { ident: '10', threshold: { lat: dm(41, 23.507455), lon: -dm(83, 38.113402) }, headingTrue: 91, patternSide: 'left', oppositeIdent: '28' },
    { ident: '28', threshold: { lat: dm(41, 23.4975), lon: -dm(83, 37.195282) }, headingTrue: 271, patternSide: 'right', oppositeIdent: '10' },
    // 18/36: 2,628 x 50 ft. Both patterns are flown east of the runway.
    { ident: '18', threshold: { lat: dm(41, 23.606173), lon: -dm(83, 38.057833) }, headingTrue: 179, patternSide: 'left', oppositeIdent: '36' },
    { ident: '36', threshold: { lat: dm(41, 23.173455), lon: -dm(83, 38.05231) }, headingTrue: 359, patternSide: 'right', oppositeIdent: '18' },
  ],
};
