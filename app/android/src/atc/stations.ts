// Controllers as the HUD draws them: an icon on the compass bar at the controller's bearing, a dot
// for whether its feed can be listened to right now, and the card you get when you look at it.

import type { HudStation } from '@web/hud';
import type { LatLon } from '@web/planes';
import { bearingDeg, haversineKm } from '../flights/geo';
import { FACILITIES } from './facilities';
import type { Facility } from './facilities';
import { agoShort } from './whoControls';

export const FEED_COLORS = { online: '#4cd964', connecting: '#ffc94d', offline: '#ff3b30', none: '#9e9e9e' };
/** Standing on top of a station its bearing means nothing (and jumps around with GPS noise). */
const TOO_CLOSE_KM = 0.25;
const LAST_CALL_FOR_S = 600;
const CALL_MAX_CHARS = 46;

export type StationInfo = {
  /** The feed's state on the Mac: online | connecting | offline | idle, or null if the Mac has no such feed. */
  status: string | null;
  /** The last call heard on it. */
  lastCall: { text: string; agoS: number } | null;
  /** Are you listening to it now? */
  connected: boolean;
};

/** What the dot says: green = can be listened to, yellow = connecting, red = was playing and stopped, grey = nothing to hear. */
export function feedColor(facility: Facility, status: string | null): string {
  if (!facility.feedId || !status || status === 'idle') return FEED_COLORS.none;
  return status === 'online' ? FEED_COLORS.online : status === 'connecting' ? FEED_COLORS.connecting : FEED_COLORS.offline;
}

export function feedWords(facility: Facility, status: string | null): string {
  if (!facility.feedId || !status) return 'No live feed';
  if (status === 'online') return 'Live';
  if (status === 'connecting') return 'Connecting…';
  return status === 'offline' ? 'Feed stopped on the Mac' : 'Not playing on the Mac';
}

const clip = (s: string) => (s.length > CALL_MAX_CHARS ? `${s.slice(0, CALL_MAX_CHARS - 1).trimEnd()}…` : s);

export function stationCard(f: Facility, info: StationInfo, distanceKm: number): string[] {
  const lines = [f.name, `${f.freqs.join(' · ')} · ${distanceKm < 10 ? distanceKm.toFixed(1) : Math.round(distanceKm)} km`];
  lines.push(info.connected ? 'Live · you are listening' : feedWords(f, info.status));
  if (info.lastCall && info.lastCall.agoS <= LAST_CALL_FOR_S) lines.push(`“${clip(info.lastCall.text)}” ${agoShort(info.lastCall.agoS)}`);
  if (info.connected) lines.push('Say “Disconnect” to stop');
  else if (info.status === 'online') lines.push('Say “Can I access?”');
  return lines;
}

/** Remembers each station's last meaningful bearing, for when you're standing on it. */
export function createStations() {
  const lastBearing = new Map<string, number>();
  return {
    build(viewer: LatLon, infoFor: (f: Facility) => StationInfo): (HudStation & { facility: Facility })[] {
      return FACILITIES.map((f) => {
        const distanceKm = haversineKm(viewer.lat, viewer.lon, f.position.lat, f.position.lon);
        if (distanceKm >= TOO_CLOSE_KM) lastBearing.set(f.id, bearingDeg(viewer.lat, viewer.lon, f.position.lat, f.position.lon));
        const info = infoFor(f);
        return {
          id: f.id,
          facility: f,
          bearingDeg: lastBearing.get(f.id) ?? 0,
          color: feedColor(f, info.status),
          tag: f.kind === 'ctaf' ? 'COMMON FREQUENCY' : 'CONTROLLER',
          card: stationCard(f, info, distanceKm),
        };
      });
    },
  };
}
