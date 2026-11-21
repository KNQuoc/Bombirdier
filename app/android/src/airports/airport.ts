// What the app knows about an airport: enough to draw its runways and traffic pattern and to tell
// which leg of the pattern a plane is on.

import type { LatLon } from '@web/planes';

export type PatternSide = 'left' | 'right';

/** One end of a runway: the end you land on and take off from when that runway is in use. */
export type RunwayEnd = {
  /** "28" */
  ident: string;
  threshold: LatLon;
  /** Direction of landing and takeoff, degrees true. */
  headingTrue: number;
  /** Which way the pattern's turns go for this runway. */
  patternSide: PatternSide;
  /** The other end of the same pavement, e.g. "10". */
  oppositeIdent: string;
};

export type Airport = {
  ident: string;
  name: string;
  /** Airport reference point. */
  position: LatLon;
  /** Field elevation, feet above mean sea level. */
  elevationFt: number;
  /** Traffic pattern altitude, feet above mean sea level. */
  tpaFtMsl: number;
  /**
   * Height of mean sea level above the WGS84 ellipsoid here, in meters (negative in the US). GPS
   * and ADS-B "geometric" altitudes are ellipsoid heights; charts use sea level. ellipsoid = MSL + this.
   */
  geoidSeparationM: number;
  runways: RunwayEnd[];
  /** The runway to assume until told otherwise (the calm-wind runway). */
  defaultRunway: string;
};

export const M_PER_FT = 0.3048;

export const runwayEnd = (airport: Airport, ident: string): RunwayEnd =>
  airport.runways.find((r) => r.ident === ident) ??
  airport.runways.find((r) => r.ident === airport.defaultRunway) ??
  airport.runways[0];

/** Feet MSL -> meters above the WGS84 ellipsoid (the reference GPS and ADS-B alt_geom use). */
export const mslFtToEllipsoidM = (airport: Airport, ft: number) => ft * M_PER_FT + airport.geoidSeparationM;
