// Radio calls on the phone: asks the Mac for what was just said on the live feed, works out which
// plane each call is about, and keeps what the HUD needs (who to highlight, what to show).
//
// The Mac only listens to a feed while someone keeps asking for its calls, so this polling is also
// what keeps the feed connected. It stops with the view (settings, background), and the Mac lets go
// of the stream two minutes later.

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
}) {
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let feeds: FeedInfo[] = [];
  let feedsAt = 0;
  let contextAt = 0;
  let since = 0;
  let firstPoll = true;
  const calls: HeardCall[] = [];

  /** The feed to listen to: the first one that is set up. (Phase 5 lets you choose by voice.) */
  const feed = () => feeds.find((f) => f.configured) ?? null;

  async function tick() {
    if (!running) return;
    const now = Date.now();
    try {
      if (deps.serverUp()) {
        if (now - feedsAt >= FEEDS_EVERY_MS) {
          feedsAt = now;
          feeds = (await deps.server.feeds()) ?? feeds;
        }
        const listening = feed();
        if (listening) {
          if (now - contextAt >= CONTEXT_EVERY_MS) {
            contextAt = now;
            const around = deps.planes().filter((p) => p.distanceKm <= CONTEXT_WITHIN_KM).sort((a, b) => a.distanceKm - b.distanceKm);
            const names = around.map((p) => p.callsign?.trim() || p.registration || '').filter(Boolean);
            void deps.server.radioContext([...new Set(names)].slice(0, CONTEXT_MAX));
          }
          const reply = await deps.server.radioEvents(listening.id, since);
          if (reply && running) {
            if (reply.feed) feeds = feeds.map((f) => (f.id === reply.feed!.id ? reply.feed! : f));
            for (const event of reply.events) {
              since = Math.max(since, event.id);
              // On connecting, the Mac hands over its whole backlog: only what was just said is shown.
              if (firstPoll && Date.now() / 1000 - event.ts > FRESH_S) continue;
              const plane = matchCall(event.callsignTokens, deps.planes());
              calls.push({ event, plane, at: Date.now() });
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
    /** For the info line: which feed, and how it's doing. */
    describe(): string {
      if (!running) return 'radio: off';
      const f = feed();
      if (!f) return feeds.length ? 'radio: no feed set up (add its stream address to mac-server/feeds.json)' : 'radio: no feeds';
      return `radio: ${f.name} ${f.status}${calls.length ? `, last call ${Math.round((Date.now() - calls.at(-1)!.at) / 1000)} s ago` : ''}`;
    },
    feeds: () => feeds,
  };
}

export type Radio = ReturnType<typeof createRadio>;
