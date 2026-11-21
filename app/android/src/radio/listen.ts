// Being "connected" to a radio feed: its live audio plays on the phone and its transcript scrolls
// on the HUD. Audio and transcript are separate switches (mute keeps the transcript, hiding the
// transcript keeps the audio), and each feed remembers how you left it for the session.
//
// The audio comes from the Mac (GET /api/feeds/{id}/audio, an MP3 stream of what the Mac itself is
// hearing) and plays in an ordinary audio element. The Mac keeps transcribing whether or not anyone
// is connected, so highlights and "heard" marks don't depend on this.

import type { MacServer } from '../voice/server';

const DEFAULT_VOLUME = 0.8;
const VOLUME_STEP = 0.2;
const MIN_VOLUME = 0.2;
/** The stream ended or failed (server restarted, capture stopped): try again this often. */
const RETRY_MS = 4000;

type Choice = { audio: boolean; transcript: boolean; volume: number };

export type ListenState = { feedId: string; audio: boolean; transcript: boolean; volume: number; playing: boolean };

export function createListener(deps: { server: MacServer }) {
  let feedId: string | null = null;
  let choice: Choice = { audio: true, transcript: true, volume: DEFAULT_VOLUME };
  /** How each feed was left: reconnecting to one you'd muted comes back muted. */
  const remembered = new Map<string, Choice>();
  let player: HTMLAudioElement | null = null;
  let playing = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  /** 0-1, multiplied in while the assistant is listening or talking. */
  let duck = 1;

  const applyVolume = () => {
    if (player) player.volume = Math.max(0, Math.min(1, choice.volume * duck));
  };

  function stopAudio() {
    clearTimeout(retry);
    playing = false;
    if (!player) return;
    const old = player;
    player = null;
    old.onerror = old.onended = old.onplaying = old.onstalled = null;
    old.pause();
    // Dropping the address is what closes the connection to the Mac.
    old.removeAttribute('src');
    old.load();
  }

  async function startAudio() {
    stopAudio();
    const id = feedId;
    if (!id || !choice.audio) return;
    const url = await deps.server.audioUrl(id);
    if (feedId !== id || !choice.audio || player) return;
    const again = () => {
      if (feedId !== id || !choice.audio) return;
      stopAudio();
      retry = setTimeout(() => void startAudio(), RETRY_MS);
    };
    if (!url) return again();
    const audio = new Audio();
    audio.preload = 'none';
    audio.onplaying = () => (playing = true);
    audio.onerror = again;
    audio.onended = again;
    player = audio;
    applyVolume();
    audio.src = url;
    audio.play().catch(again);
  }

  const save = () => {
    if (feedId) remembered.set(feedId, { ...choice });
  };

  return {
    /** null while not connected. */
    state: (): ListenState | null => (feedId ? { feedId, ...choice, playing } : null),
    connected: () => feedId,

    connect(id: string) {
      if (feedId === id) return;
      save();
      feedId = id;
      choice = { ...(remembered.get(id) ?? { audio: true, transcript: true, volume: DEFAULT_VOLUME }) };
      void startAudio();
    },
    disconnect() {
      save();
      feedId = null;
      stopAudio();
    },
    /** on / off: mute and unmute. up / down: volume (and unmutes). False if not connected. */
    audio(state: string): boolean {
      if (!feedId) return false;
      if (state === 'off') {
        choice.audio = false;
        stopAudio();
      } else {
        if (state === 'up') choice.volume = Math.min(1, choice.volume + VOLUME_STEP);
        if (state === 'down') choice.volume = Math.max(MIN_VOLUME, choice.volume - VOLUME_STEP);
        const wasOn = choice.audio;
        choice.audio = true;
        if (!wasOn || !player) void startAudio();
        else applyVolume();
      }
      save();
      return true;
    },
    transcript(state: string): boolean {
      if (!feedId) return false;
      choice.transcript = state !== 'hide';
      save();
      return true;
    },
    /** Lower the radio while the assistant listens (so the microphone doesn't hear it) or talks. */
    duck(level: number) {
      if (level === duck) return;
      duck = level;
      applyVolume();
    },
    /** The view is going away (settings, background): stop the sound, keep the connection choice. */
    pause: stopAudio,
    resume() {
      if (feedId && choice.audio && !player) void startAudio();
    },
  };
}

export type Listener = ReturnType<typeof createListener>;
