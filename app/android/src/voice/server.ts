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

export type AskResponse = {
  transcript: string;
  answer: string;
  actions: VoiceAction[];
  /** Who answered: "rules" (instant, on the Mac), "aivana", "offline" (Aivana unreachable) or "error". */
  source: string;
  timings?: Record<string, number>;
  error?: string;
};

export type ServerHealth = { ok: boolean; whisper: string; aivana: boolean };

/** Whisper plus Aivana can take several seconds; past this something is wrong. */
const ASK_TIMEOUT_MS = 30_000;
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

export function createServer(getUrl: () => string) {
  const base = () => (getUrl().trim() || DEFAULT_SERVER_URL).replace(/\/+$/, '');
  return {
    url: base,
    /** null = unreachable. */
    async health(): Promise<ServerHealth | null> {
      try {
        const r = await request(`${base()}/api/health`, {}, HEALTH_TIMEOUT_MS);
        return r.ok ? ((await r.json()) as ServerHealth) : null;
      } catch {
        return null;
      }
    },
    /** Throws if the server can't be reached or answers with an error status. */
    async ask(body: { audio?: string; mime?: string; text?: string; context: unknown }): Promise<AskResponse> {
      const r = await request(
        `${base()}/api/voice/ask`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        ASK_TIMEOUT_MS,
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as AskResponse;
    },
  };
}

export type MacServer = ReturnType<typeof createServer>;
