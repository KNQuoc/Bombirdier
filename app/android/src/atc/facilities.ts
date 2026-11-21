// The controllers Bombirdier knows about: who a plane near here might be talking to, where their
// icon sits on the compass bar (the controller's airport or radar site), and which radio feed on
// the Mac carries them (mac-server/feeds.json).
//
// A small hand-made list. A facility is only worth adding when there is a feed to listen to.

import type { LatLon } from '@web/planes';

export type Facility = {
  id: string;
  /** "Toledo Approach": what the card and the assistant call it. */
  name: string;
  kind: 'ctaf' | 'approach' | 'center';
  position: LatLon;
  /** MHz, as printed on charts. */
  freqs: string[];
  /** The feed in mac-server/feeds.json that carries it, or null if there's nothing to listen to. */
  feedId: string | null;
};

export const WOOD_COUNTY_CTAF: Facility = {
  id: '1g0-ctaf',
  name: 'Wood County CTAF',
  kind: 'ctaf',
  position: { lat: 41.391, lon: -83.6301389 },
  freqs: ['122.975'],
  feedId: '1g0-ctaf',
};

/** Toledo Express (KTOL). The feed mixes both approach sectors with Tower, Ground and Clearance. */
export const TOLEDO_APPROACH: Facility = {
  id: 'tol-app',
  name: 'Toledo Approach',
  kind: 'approach',
  position: { lat: 41.58682, lon: -83.80783 },
  // 126.1 works the east half (bearings 360-179 from the airport), 134.35 the west half.
  freqs: ['126.1', '134.35'],
  feedId: 'tol-app',
};

/** Detroit Metro (KDTW): approach, departure and tower, each its own feed. Which sector a plane is on is not guessed. */
export const DETROIT_APPROACH: Facility = {
  id: 'dtw-app',
  name: 'Detroit Metro',
  kind: 'approach',
  position: { lat: 42.21244, lon: -83.35339 },
  freqs: ['124.05'],
  feedId: 'dtw-app-west',
};

/** John Glenn Columbus (KCMH): approach sectors and tower, each its own feed. */
export const COLUMBUS_APPROACH: Facility = {
  id: 'cmh-app',
  name: 'Columbus',
  kind: 'approach',
  position: { lat: 39.99799, lon: -82.89188 },
  freqs: ['125.95'],
  feedId: 'cmh-app-north',
};

/** Cleveland Center (ZOB), at Oberlin, Ohio. Its feeds are sectors: Bluffton High is the one over northwest Ohio. */
export const CLEVELAND_CENTER: Facility = {
  id: 'zob',
  name: 'Cleveland Center',
  kind: 'center',
  position: { lat: 41.2972, lon: -82.2061 },
  freqs: ['119.325'],
  feedId: 'zob-47',
};

export const FACILITIES: Facility[] = [WOOD_COUNTY_CTAF, TOLEDO_APPROACH, DETROIT_APPROACH, CLEVELAND_CENTER, COLUMBUS_APPROACH];

export const facilityForFeed = (feedId: string | null | undefined) => (feedId ? (FACILITIES.find((f) => f.feedId === feedId) ?? null) : null);

/** A feed as far as grouping goes (the Mac's feed list: voice/server.ts FeedInfo). */
type FeedRef = { id: string; facility: string };

/**
 * A controller's channels: every feed on the Mac that names it as its facility. Detroit has one
 * icon and several frequencies (Arrival West, Arrival East, Tower...), each a feed of its own in
 * mac-server/feeds.json, so adding a frequency there needs no change here.
 */
export function channelsOf<T extends FeedRef>(facility: Facility, feeds: T[]): T[] {
  const mine = feeds.filter((f) => f.facility === facility.id);
  return mine.length ? mine : feeds.filter((f) => f.id === facility.feedId);
}

/** The controller a feed belongs to. */
export function facilityOfFeed(feed: FeedRef | null | undefined): Facility | null {
  if (!feed) return null;
  return FACILITIES.find((f) => f.id === feed.facility) ?? facilityForFeed(feed.id);
}
