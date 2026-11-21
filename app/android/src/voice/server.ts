// Talking to the Mac server (mac-server/): health check and the voice question endpoint.
//
// On the phone, fetch() is native (CapacitorHttp), so plain http and CORS are not a problem. Over
// USB the default URL works after `adb reverse tcp:8787 tcp:8787`; over Wi-Fi the URL is the Mac's
// LAN address (Settings -> Mac server).

export const DEFAULT_SERVER_URL = 'http://localhost:8787';

/** One thing the assistant wants done. Mirrors ACTIONS in mac-server/tools.py. */
export type VoiceAction = {
  type: string;
  filter?: unknown;
  by?: string;
  order?: string;
  direction?: string;
  query?: string;
  n?: number;
  nm?: number;
  runway?: string;
  /** sky_filter: use the list's current filter. */
  fromList?: boolean;
  /** ar_range: how far out the bar shows planes, km; 0 = the default. */
  km?: number;
  /** connect_feed: the radio feed's id. */
  feed?: string;
  /** radio_audio: on | off | up | down. transcript: show | hide. */
  state?: string;
};

/** A spoken answer as audio, base64-encoded. */
export type SpeechClip = { audio: string; mime: string };

export type AskResponse = {
  transcript: string;
  answer: string;
  /** `answer` in the assistant's voice (made on the Mac), when the Mac has one. */
  speech?: SpeechClip;
  actions: VoiceAction[];
  /** Who answered: "rules" (instant, on the Mac), "aivana", "offline" (Aivana unreachable) or "error". */
  source: string;
  timings?: Record<string, number>;
  error?: string;
};

/** One call heard on a radio feed, as the Mac transcribed and parsed it (mac-server/feeds.py). */
export type RadioEvent = {
  id: number;
  feedId: string;
  /** When it was heard, seconds since 1970. */
  ts: number;
  text: string;
  /** Callsigns and tail-number fragments in the call, in the order said: "DAL1830", "901BG". */
  callsignTokens: string[];
  /** "left downwind" and the like, from a pattern position report. */
  reportedLeg: string | null;
  runway: string | null;
};

export type FeedInfo = {
  id: string;
  name: string;
  freqs: string[];
  /** Can the Mac listen to it (a browser-tab feed, a stream address, or a test recording)? */
  configured: boolean;
  /** idle | connecting | online | offline */
  status: string;
};

function feedInfo(value: unknown): FeedInfo | null {
  const f = value as Record<string, unknown> | null;
  if (!f || typeof f.id !== 'string') return null;
  return {
    id: f.id.slice(0, 40),
    name: String(f.name ?? f.id).slice(0, 60),
    freqs: Array.isArray(f.freqs) ? f.freqs.map((x) => String(x).slice(0, 12)).slice(0, 6) : [],
    configured: f.configured === true,
    status: ['idle', 'connecting', 'online', 'offline'].includes(f.status as string) ? (f.status as string) : 'idle',
  };
}

function radioEvent(value: unknown): RadioEvent | null {
  const e = value as Record<string, unknown> | null;
  if (!e || typeof e.id !== 'number' || typeof e.text !== 'string') return null;
  return {
    id: e.id,
    feedId: String(e.feedId ?? '').slice(0, 40),
    ts: typeof e.ts === 'number' ? e.ts : 0,
    text: e.text.slice(0, 400),
    callsignTokens: Array.isArray(e.callsignTokens) ? e.callsignTokens.filter((t) => typeof t === 'string').map((t) => (t as string).slice(0, 10)).slice(0, 6) : [],
    reportedLeg: typeof e.reportedLeg === 'string' ? e.reportedLeg.slice(0, 30) : null,
    runway: typeof e.runway === 'string' ? e.runway.slice(0, 4) : null,
  };
}

export type ServerHealth = {
  ok: boolean;
  whisper: string;
  /** The Mac's voice: "ready" when it can speak answers; otherwise the phone's built-in voice is used. */
  tts: string;
  aivana: boolean;
  /** True when this connection needs the server token (Wi-Fi). */
  tokenNeeded: boolean;
};

/** Whisper plus Aivana can take several seconds; past this something is wrong. */
const ASK_TIMEOUT_MS = 30_000;
/** Speech is generated in well under a second; if it takes this long, use the phone's own voice. */
const SPEAK_TIMEOUT_MS = 4000;

/** A clip from a server reply, if it's really there and plausibly audio. */
function clip(value: unknown): SpeechClip | undefined {
  const c = value as Partial<SpeechClip> | null;
  return c && typeof c.audio === 'string' && c.audio.length > 0 && typeof c.mime === 'string' && c.mime.startsWith('audio/')
    ? { audio: c.audio, mime: c.mime }
    : undefined;
}
const HEALTH_TIMEOUT_MS = 3000;

async function request(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
  });
  try {
    return await Promise.race([fetch(url, init), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function createServer(getUrl: () => string, getToken: () => string = () => '') {
  const base = () => (getUrl().trim() || DEFAULT_SERVER_URL).replace(/\/+$/, '');
  const headers = () => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = getToken().trim();
    if (token) h['X-Bombirdier-Token'] = token;
    return h;
  };
  return {
    url: base,
    /** null = unreachable. */
    async health(): Promise<ServerHealth | null> {
      try {
        const r = await request(`${base()}/api/health`, {}, HEALTH_TIMEOUT_MS);
        if (!r.ok) return null;
        // Don't trust the shape: this text ends up on screen.
        const h = (await r.json()) as Record<string, unknown>;
        return {
          ok: h.ok === true,
          whisper: String(h.whisper ?? '').slice(0, 80),
          tts: String(h.tts ?? 'off').slice(0, 80),
          aivana: h.aivana === true,
          tokenNeeded: h.tokenNeeded === true,
        };
      } catch {
        return null;
      }
    },
    /** Throws if the server can't be reached or answers with an error status (401 = wrong or missing token). */
    async ask(body: { audio?: string; mime?: string; text?: string; context: unknown }): Promise<AskResponse> {
      const r = await request(`${base()}/api/voice/ask`, { method: 'POST', headers: headers(), body: JSON.stringify(body) }, ASK_TIMEOUT_MS);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      // Don't trust the shape: these strings are shown and spoken, the numbers are shown.
      const d = (await r.json()) as Record<string, unknown>;
      const timings: Record<string, number> = {};
      for (const [k, v] of Object.entries((d.timings as Record<string, unknown>) ?? {})) if (typeof v === 'number') timings[k] = v;
      return {
        transcript: String(d.transcript ?? '').slice(0, 500),
        answer: String(d.answer ?? '').slice(0, 800),
        actions: Array.isArray(d.actions) ? (d.actions.filter((a) => a && typeof a === 'object' && typeof (a as VoiceAction).type === 'string') as VoiceAction[]) : [],
        source: ['rules', 'aivana', 'offline', 'error'].includes(d.source as string) ? (d.source as string) : 'unknown',
        timings,
        error: d.error == null ? undefined : String(d.error).slice(0, 200),
        speech: clip(d.speech),
      };
    },
    /** The radio feeds the Mac knows about. null = couldn't ask. */
    async feeds(): Promise<FeedInfo[] | null> {
      try {
        const r = await request(`${base()}/api/feeds`, { headers: headers() }, HEALTH_TIMEOUT_MS);
        if (!r.ok) return null;
        const list = ((await r.json()) as Record<string, unknown>).feeds;
        return Array.isArray(list) ? (list.map(feedInfo).filter(Boolean) as FeedInfo[]) : null;
      } catch {
        return null;
      }
    },
    /**
     * Calls heard on every feed since event `since`, oldest first, with how each feed is doing.
     * Asking is what keeps the Mac listening to a feed it connects to itself.
     */
    async radioEvents(since: number): Promise<{ events: RadioEvent[]; feeds: FeedInfo[] } | null> {
      try {
        const r = await request(`${base()}/api/radio/events?since=${since}`, { headers: headers() }, HEALTH_TIMEOUT_MS);
        if (!r.ok) return null;
        const d = (await r.json()) as Record<string, unknown>;
        return {
          events: Array.isArray(d.events) ? (d.events.map(radioEvent).filter(Boolean) as RadioEvent[]) : [],
          feeds: Array.isArray(d.feeds) ? (d.feeds.map(feedInfo).filter(Boolean) as FeedInfo[]) : [],
        };
      } catch {
        return null;
      }
    },
    /**
     * The address to play a feed's live audio from, or null if the Mac won't give one. An audio
     * player can't send the token header, so the Mac hands out a one-time ticket that goes in the address.
     */
    async audioUrl(feedId: string): Promise<string | null> {
      try {
        const r = await request(`${base()}/api/feeds/${encodeURIComponent(feedId)}/listen`, { method: 'POST', headers: headers() }, HEALTH_TIMEOUT_MS);
        if (!r.ok) return null;
        const ticket = ((await r.json()) as Record<string, unknown>).ticket;
        return typeof ticket === 'string' && /^[\w-]{8,80}$/.test(ticket) ? `${base()}/api/feeds/${encodeURIComponent(feedId)}/audio?ticket=${ticket}` : null;
      } catch {
        return null;
      }
    },
    /** The wind at the weather station nearest a point, or null if the Mac couldn't say. */
    async wind(lat: number, lon: number): Promise<{ dirDeg: number | null; speedKt: number; gustKt: number | null; station: string; distanceNm: number | null } | null> {
      try {
        const r = await request(`${base()}/api/weather/wind?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`, { headers: headers() }, HEALTH_TIMEOUT_MS + 2000);
        if (!r.ok) return null;
        const w = ((await r.json()) as Record<string, unknown>).wind as Record<string, unknown> | null;
        if (!w || typeof w.speedKt !== 'number') return null;
        return {
          dirDeg: typeof w.dirDeg === 'number' ? w.dirDeg : null,
          speedKt: w.speedKt,
          gustKt: typeof w.gustKt === 'number' ? w.gustKt : null,
          station: String(w.station ?? '').slice(0, 40),
          distanceNm: typeof w.distanceNm === 'number' ? w.distanceNm : null,
        };
      } catch {
        return null;
      }
    },
    /** Tells the Mac which callsigns are around, so Whisper knows what to expect on the radio. */
    async radioContext(callsigns: string[], byFeed: Record<string, string[]> = {}): Promise<void> {
      try {
        await request(`${base()}/api/radio/context`, { method: 'POST', headers: headers(), body: JSON.stringify({ callsigns, byFeed }) }, HEALTH_TIMEOUT_MS);
      } catch {
        // It only helps spelling: not worth reporting.
      }
    },
    /** `text` in the assistant's voice, or null if the Mac can't speak it (then the phone's own voice is used). */
    async speech(text: string): Promise<SpeechClip | null> {
      try {
        const r = await request(`${base()}/api/voice/speak`, { method: 'POST', headers: headers(), body: JSON.stringify({ text }) }, SPEAK_TIMEOUT_MS);
        return r.ok ? (clip(((await r.json()) as Record<string, unknown>).speech) ?? null) : null;
      } catch {
        return null;
      }
    },
  };
}

export type MacServer = ReturnType<typeof createServer>;
