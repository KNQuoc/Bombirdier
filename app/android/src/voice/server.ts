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
