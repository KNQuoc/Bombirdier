// Two-speed traffic data.
//   near: the AR view's planes (AR radius, default 50 km), polled every 5-30 s. Goes to the HUD.
//   wide: every plane within 250 nm, polled about once a minute. Goes to the list and the radar.
// all() merges the two by plane id; the near copy wins because it is fresher.

import type { LatLon, Plane } from '@web/planes';
import { startLiveFeed } from '../flights/feed';
import type { NearFeed } from '../flights/feed';
import { DEFAULT_RADIUS_KM, KM_PER_NM, WIDE_RADIUS_NM } from '../flights/nearby';
import { startWideFeed } from './wide';
import type { WideFeed, WideMode } from './wide';

export type Traffic = {
  near: NearFeed;
  wide: WideFeed;
  arRadiusKm: number;
  /** Every known plane, in no particular order. Meant to be called about once a second, not per frame. */
  all: () => Plane[];
  /** What all() covers, how old the wide data is, and why it's missing or stale ('' = fine). */
  coverage: () => { radius: string; ageS: number | null; note: string };
  stop: () => void;
};

export function startTraffic(opts: {
  arRadiusKm: number | null;
  wideMode: WideMode;
  getPosition: () => LatLon | null;
}): Traffic {
  const arRadiusKm = opts.arRadiusKm ?? DEFAULT_RADIUS_KM;
  const near = startLiveFeed({ radiusKm: arRadiusKm, getPosition: opts.getPosition });
  const wide = startWideFeed({ mode: opts.wideMode, getPosition: opts.getPosition, nearThrottled: near.throttled });

  return {
    near,
    wide,
    arRadiusKm,
    all: () => {
      const nearPlanes = near.get().planes;
      const widePlanes = wide.planes(opts.getPosition());
      if (!widePlanes.length) return nearPlanes;
      const byId = new Map<string, Plane>();
      for (const p of widePlanes) byId.set(p.id, p);
      for (const p of nearPlanes) byId.set(p.id, p);
      return [...byId.values()];
    },
    coverage: () => {
      const fetchedAt = wide.fetchedAt();
      if (fetchedAt != null) {
        return { radius: `${WIDE_RADIUS_NM} nm`, ageS: Math.round((Date.now() - fetchedAt) / 1000), note: wide.note() };
      }
      // No wide data (off, no Wi-Fi, still loading): the list shows the AR feed's planes, which are
      // never more than a poll old.
      return { radius: `${Math.round(arRadiusKm / KM_PER_NM)} nm`, ageS: null, note: wide.note() };
    },
    stop: () => {
      near.stop();
      wide.stop();
    },
  };
}
