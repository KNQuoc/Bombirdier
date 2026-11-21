// The slow, wide half of the two-speed traffic data: every plane within 250 nm, for the list and
// the radar. One adsb.lol request about once a minute; the AR view never sees these planes.

import type { LatLon, Plane } from '@web/planes';
import { extrapolate } from '../flights/feed';
import { widePlanes } from '../flights/nearby';
import { onWifi } from './network';

export type WideMode = 'on' | 'wifi' | 'off';

/** How often the 250 nm area is fetched. Positions are dead-reckoned in between, on demand. */
const WIDE_POLL_MS = 60_000;
/** The first fetch waits this long so the AR feed gets the first request. */
const FIRST_POLL_DELAY_MS = 2500;
/** While something is in the way (no GPS, no Wi-Fi, AR feed throttled), look again this often. */
const RETRY_MS = 10_000;
const GPS_WAIT_MS = 1000;
/** Wide planes are moved along their tracks at most this often, and only when someone asks. */
const EXTRAPOLATE_EVERY_MS = 2000;

export type WideFeed = {
  /** Planes at their current (dead-reckoned) positions relative to `viewer`. Empty until the first fetch. */
  planes: (viewer: LatLon | null) => Plane[];
  /** When the data was fetched (Date.now() ms), or null before the first fetch. */
  fetchedAt: () => number | null;
  /** Size of the last response in bytes (JSON text), or null before the first fetch. */
  bytes: () => number | null;
  /** Why there is no fresh data, for the list header and the info line. '' = all good. */
  note: () => string;
  stop: () => void;
};

/**
 * Polls adsb.lol for the 250 nm area. It stays out of the AR feed's way: both share adsb.lol's
 * per-IP rate limit (and the cooldown in flights/adsb.ts), so the wide poll is skipped whenever the
 * AR feed's latest poll was throttled.
 */
export function startWideFeed(opts: {
  mode: WideMode;
  getPosition: () => LatLon | null;
  nearThrottled: () => boolean;
}): WideFeed {
  let polled: { planes: Plane[]; fetchedAt: number; at: LatLon; bytes: number } | null = null;
  let note = opts.mode === 'off' ? 'wide traffic off' : 'loading';
  let cache: { at: number; planes: Plane[] } | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const again = (ms: number) => {
    if (!stopped) timer = setTimeout(poll, ms);
  };

  async function poll() {
    const pos = opts.getPosition();
    if (!pos) {
      note = 'waiting for GPS';
      return again(GPS_WAIT_MS);
    }
    if (opts.mode === 'wifi' && !onWifi()) {
      note = 'waiting for Wi-Fi';
      return again(RETRY_MS);
    }
    if (opts.nearThrottled()) {
      note = 'rate limited';
      return again(RETRY_MS);
    }
    const { planes, problem, fetchedAt, bytes } = await widePlanes(pos.lat, pos.lon);
    if (stopped) return;
    // On a failure widePlanes returns the last good wide data (or nothing): keep whichever is newer.
    if (planes.length || !polled) polled = { planes, fetchedAt, at: pos, bytes };
    cache = null;
    note = problem === 'rate-limited' ? 'rate limited' : problem === 'unreachable' ? 'adsb.lol unreachable' : '';
    again(problem ? RETRY_MS * 2 : WIDE_POLL_MS);
  }

  if (opts.mode !== 'off') timer = setTimeout(poll, FIRST_POLL_DELAY_MS);

  return {
    planes: (viewer) => {
      if (!polled) return [];
      const now = Date.now();
      if (!cache || now - cache.at >= EXTRAPOLATE_EVERY_MS) {
        cache = { at: now, planes: extrapolate(polled.planes, polled.fetchedAt, now, viewer ?? polled.at) };
      }
      return cache.planes;
    },
    fetchedAt: () => polled?.fetchedAt ?? null,
    bytes: () => polled?.bytes ?? null,
    note: () => note,
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
