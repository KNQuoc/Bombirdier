// Radio calls on the phone: asks the Mac for what was just said on the live feeds, works out which
// plane each call is about, and keeps what the HUD needs (who to highlight, what to show).
//
// Every feed the Mac has is followed at once. The first feed in mac-server/feeds.json is the home
// frequency: everything said on it is shown. On the others (Approach, Center: busy, and mostly about
// planes far away) a call is shown only when it names a plane the app knows.
//
// A feed the Mac connects to itself is only listened to while someone keeps asking for its calls,
// so this polling is also what keeps it connected. It stops with the view (settings, background).

import type { Plane } from '@web/planes';
import type { FeedInfo, MacServer, RadioEvent } from '../voice/server';
import { matchCall } from './match';

/** How often the Mac is asked for new calls (no streaming through Capacitor's native HTTP). */
const POLL_MS = 500;
const FEEDS_EVERY_MS = 10_000;
/** The callsigns around are sent this often so Whisper knows which names to expect. */
const CONTEXT_EVERY_MS = 5000;
const CONTEXT_WITHIN_KM = 150;
const CONTEXT_MAX = 120;
/** A call older than this when it arrives (first connection, after a pause) is history, not news. */
const FRESH_S = 15;
/** How long a call's plane stays highlighted, and how long its text stays up. */
export const HIGHLIGHT_MS = 8000;
const SUBTITLE_MS = 9000;
/** A leg said on the radio is shown on the plane's card for this long. */
const REPORTED_LEG_MS = 60_000;
const CALLS_KEPT = 8;
/** Per feed, for the transcript shown while you're listening to it. */
const TRANSCRIPT_KEPT = 8;
/** "Heard on Toledo Approach" stays true this long after the call. */
const HEARD_FOR_MS = 10 * 60_000;

export type HeardCall = {
  event: RadioEvent;
  /** The plane it's about, as it was when the call came in. null = nobody we know. */
  plane: Plane | null;
  /** Date.now() when the phone received it. */
  at: number;
};

export function createRadio(deps: {
  server: MacServer;
  /** Every plane the app knows (near and wide): Approach talks to planes far outside the AR view. */
  planes: () => Plane[];
  /** Is the Mac server there at all? No point asking otherwise. */
  serverUp: () => boolean;
  /**
   * Per feed id, the callsigns that controller is probably working (most likely first). A Center
   * sector or an approach control 150 km away talks to other planes than the ones nearest you.
   */
  callsignsByFeed?: () => Record<string, string[]>;
}) {
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let feeds: FeedInfo[] = [];
  let feedsAt = 0;
  let contextAt = 0;
  let since = 0;
  let firstPoll = true;
  const calls: HeardCall[] = [];
  /** Everything said on each feed, matched to a plane or not. */
  const transcripts = new Map<string, HeardCall[]>();
  /** Plane id -> the feed it was last named on. */
  const heardOn = new Map<string, { feedId: string; at: number }>();

  const usable = () => feeds.filter((f) => f.configured);
  /** The home frequency: the first feed that is set up. */
  const home = () => usable()[0] ?? null;

  async function tick() {
    if (!running) return;
    const now = Date.now();
    try {
      if (deps.serverUp()) {
        if (now - feedsAt >= FEEDS_EVERY_MS) {
          feedsAt = now;
          feeds = (await deps.server.feeds()) ?? feeds;
        }
        if (usable().length) {
          if (now - contextAt >= CONTEXT_EVERY_MS) {
            contextAt = now;
            const around = deps.planes().filter((p) => p.distanceKm <= CONTEXT_WITHIN_KM).sort((a, b) => a.distanceKm - b.distanceKm);
            const names = around.map((p) => p.callsign?.trim() || p.registration || '').filter(Boolean);
            void deps.server.radioContext([...new Set(names)].slice(0, CONTEXT_MAX), deps.callsignsByFeed?.() ?? {});
          }
          const reply = await deps.server.radioEvents(since);
          if (reply && running) {
            if (reply.feeds.length) feeds = reply.feeds;
            const homeId = home()?.id;
            for (const event of reply.events) {
              since = Math.max(since, event.id);
              // On connecting, the Mac hands over its whole backlog: only what was just said is shown.
              if (firstPoll && Date.now() / 1000 - event.ts > FRESH_S) continue;
              const plane = matchCall(event.callsignTokens, deps.planes());
              const call = { event, plane, at: Date.now() };
              const log = transcripts.get(event.feedId) ?? [];
              log.push(call);
              while (log.length > TRANSCRIPT_KEPT) log.shift();
              transcripts.set(event.feedId, log);
              if (plane) heardOn.set(plane.id, { feedId: event.feedId, at: call.at });
              // Away from the home frequency, a call about nobody we can see is just noise in the view.
              if (!plane && event.feedId !== homeId) continue;
              calls.push(call);
              console.info(`[radio] ${event.feedId}: "${event.text}" -> ${plane ? (plane.callsign ?? plane.registration ?? plane.id) : `no match for [${event.callsignTokens.join(', ')}]`}`);
            }
            firstPoll = false;
            while (calls.length > CALLS_KEPT) calls.shift();
          }
        }
      }
    } catch {
      // A missed poll doesn't matter: the next one asks for everything since the last event seen.
    }
    if (running) timer = setTimeout(tick, POLL_MS);
  }

  return {
    start() {
      if (running) return;
      running = true;
      firstPoll = true;
      feedsAt = contextAt = 0;
      void tick();
    },
    stop() {
      running = false;
      clearTimeout(timer);
    },
    /** Planes named on the radio in the last few seconds: they get a pulsing ring. */
    highlightIds(now = Date.now()): string[] {
      return [...new Set(calls.filter((c) => c.plane && now - c.at <= HIGHLIGHT_MS).map((c) => c.plane!.id))];
    },
    /** The call to show right now, or null. */
    latest(now = Date.now()): HeardCall | null {
      const last = calls.at(-1);
      return last && now - last.at <= SUBTITLE_MS ? last : null;
    },
    /** What a plane last said about where it is in the pattern ("left downwind 28"), if recent. */
    reportedLeg(planeId: string, now = Date.now()): string | null {
      for (let i = calls.length - 1; i >= 0; i--) {
        const c = calls[i];
        if (c.plane?.id !== planeId || now - c.at > REPORTED_LEG_MS || !c.event.reportedLeg) continue;
        return [c.event.reportedLeg, c.event.runway].filter(Boolean).join(' ');
      }
      return null;
    },
    /** For the info line: which feeds are coming in. */
    describe(): string {
      if (!running) return 'radio: off';
      if (!usable().length) return feeds.length ? 'radio: no feed set up in mac-server/feeds.json' : 'radio: no feeds';
      const live = usable().filter((f) => f.status === 'online');
      if (!live.length) return `radio: nothing playing (0 of ${usable().length} feeds; on the Mac, open localhost:8787/capture)`;
      const names = live.length <= 2 ? live.map((f) => f.name).join(' + ') : `${live.length} feeds`;
      return `radio: ${names}${calls.length ? `, last call ${Math.round((Date.now() - calls.at(-1)!.at) / 1000)} s ago` : ''}`;
    },
    feeds: () => feeds,
    feed: (feedId: string | null | undefined) => feeds.find((f) => f.id === feedId) ?? null,
    /** The last `n` calls on one feed, oldest first: every call, whoever it was about. */
    transcript: (feedId: string, n: number): HeardCall[] => (transcripts.get(feedId) ?? []).slice(-n),
    /** The last `n` calls over several feeds together, oldest first: a controller's channels as one transcript. */
    merged(feedIds: string[], n: number): HeardCall[] {
      return feedIds
        .flatMap((id) => transcripts.get(id) ?? [])
        .sort((a, b) => a.at - b.at || a.event.id - b.event.id)
        .slice(-n);
    },
    /** Which feed a plane was last named on, if recently: evidence of who it's talking to. */
    heardOn(planeId: string, now = Date.now()): { feedId: string; agoS: number } | null {
      const h = heardOn.get(planeId);
      return h && now - h.at <= HEARD_FOR_MS ? { feedId: h.feedId, agoS: Math.round((now - h.at) / 1000) } : null;
    },
  };
}

export type Radio = ReturnType<typeof createRadio>;
