// Controllers as the HUD draws them: an icon on the compass bar at the controller's bearing, a dot
// for whether it can be listened to right now, and the card you get when you look at it.
//
// A controller can have several frequencies (Detroit: Arrival West, Arrival East, Tower...), each a
// feed of its own on the Mac. They share one icon; the card lists them as channels.

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
/** Channels listed on a card before "+2 more". */
const CHANNELS_SHOWN = 5;

export type ChannelInfo = {
  feedId: string;
  /** "Arrival West" */
  label: string;
  freqs: string[];
  /** The feed's state on the Mac: online | connecting | offline | idle. */
  status: string;
  /** The last call heard on it. */
  lastCall: { text: string; agoS: number } | null;
};

export type StationInfo = {
  /** Empty = the Mac has no feed for this controller. */
  channels: ChannelInfo[];
  /** The channel you are listening to now, if it is one of these. */
  listeningTo: string | null;
};

/** The dot: green = something to listen to, yellow = connecting, red = was playing and stopped, grey = nothing to hear. */
export function feedColor(info: StationInfo): string {
  const states = info.channels.map((c) => c.status);
  if (states.includes('online')) return FEED_COLORS.online;
  if (states.includes('connecting')) return FEED_COLORS.connecting;
  return states.includes('offline') ? FEED_COLORS.offline : FEED_COLORS.none;
}

function statusWords(status: string | null): string {
  if (!status) return 'No live feed';
  if (status === 'online') return 'Live';
  if (status === 'connecting') return 'Connecting…';
  return status === 'offline' ? 'Feed stopped on the Mac' : 'Not playing on the Mac';
}

const clip = (s: string) => (s.length > CALL_MAX_CHARS ? `${s.slice(0, CALL_MAX_CHARS - 1).trimEnd()}…` : s);
const km = (d: number) => `${d < 10 ? d.toFixed(1) : Math.round(d)} km`;

export function stationCard(f: Facility, info: StationInfo, distanceKm: number): string[] {
  const chans = info.channels;
  const listening = chans.find((c) => c.feedId === info.listeningTo) ?? null;
  const recent = chans
    .filter((c) => c.lastCall && c.lastCall.agoS <= LAST_CALL_FOR_S)
    .sort((a, b) => a.lastCall!.agoS - b.lastCall!.agoS)[0];

  if (chans.length <= 1) {
    const only = chans[0] ?? null;
    const lines = [f.name, `${(only?.freqs.length ? only.freqs : f.freqs).join(' · ')} · ${km(distanceKm)}`];
    lines.push(listening ? 'Live · you are listening' : statusWords(only?.status ?? null));
    if (recent) lines.push(`“${clip(recent.lastCall!.text)}” ${agoShort(recent.lastCall!.agoS)}`);
    if (listening) lines.push('Say “Disconnect” to stop');
    else if (only?.status === 'online') lines.push('Say “Can I access?”');
    return lines;
  }

  // Several channels: live ones first, each on its own line.
  const live = chans.filter((c) => c.status === 'online');
  const lines = [f.name, `${km(distanceKm)} · ${live.length} of ${chans.length} channels live`];
  const ordered = [...live, ...chans.filter((c) => c.status !== 'online')];
  for (const c of ordered.slice(0, CHANNELS_SHOWN)) {
    const mark = c.feedId === info.listeningTo ? '▶' : c.status === 'online' ? '●' : '○';
    lines.push(`${mark} ${c.label} ${c.freqs.join(' / ')}`.trimEnd());
  }
  if (ordered.length > CHANNELS_SHOWN) lines.push(`+ ${ordered.length - CHANNELS_SHOWN} more`);
  if (recent) lines.push(`“${clip(recent.lastCall!.text)}” ${agoShort(recent.lastCall!.agoS)} · ${recent.label}`);
  if (listening) {
    const other = live.find((c) => c.feedId !== listening.feedId);
    lines.push(other ? `Say “switch to ${other.label}” or “Disconnect”` : 'Say “Disconnect” to stop');
  } else if (live.length) lines.push('Say “Can I access?”');
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
          color: feedColor(info),
          tag: f.kind === 'ctaf' ? 'COMMON FREQUENCY' : 'CONTROLLER',
          card: stationCard(f, info, distanceKm),
        };
      });
    },
  };
}
