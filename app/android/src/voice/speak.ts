// Says the assistant's answer out loud.
//
// Preferred: audio made on the Mac by Kokoro, a natural-sounding voice (mac-server/tts.py), played
// here. Fallback, when the Mac has no voice or the clip can't be fetched or played: Android's own
// text-to-speech through a Capacitor plugin (speechSynthesis is unreliable in an Android WebView),
// or speechSynthesis in a desktop browser.

import { Capacitor } from '@capacitor/core';
import { TextToSpeech } from '@capacitor-community/text-to-speech';
import type { SpeechClip } from './server';

const NATIVE = Capacitor.isNativePlatform();
let playing: HTMLAudioElement | null = null;

function toBlob(clip: SpeechClip): Blob {
  const binary = atob(clip.audio);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: clip.mime });
}

/** Plays a clip to the end. Rejects if it can't be played (the caller then uses the built-in voice). */
function play(clip: SpeechClip): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(toBlob(clip));
    const audio = new Audio(url);
    const finish = (ok: boolean) => {
      URL.revokeObjectURL(url);
      if (playing === audio) playing = null;
      if (ok) resolve();
      else reject(new Error('playback failed'));
    };
    audio.onended = () => finish(true);
    audio.onerror = () => finish(false);
    // stopSpeaking() pauses it: that's the end of this answer, not a failure.
    audio.onpause = () => !audio.ended && finish(true);
    playing = audio;
    audio.play().catch(() => finish(false));
  });
}

async function builtInVoice(text: string): Promise<void> {
  try {
    if (NATIVE) {
      await TextToSpeech.speak({ text, lang: 'en-US', rate: 1.05, pitch: 1.0, volume: 1.0 });
      return;
    }
    if (!('speechSynthesis' in window)) return;
    await new Promise<void>((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US';
      u.rate = 1.05;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
      // Some browsers never fire onend if speech is blocked: don't hang the assistant on it.
      setTimeout(resolve, 1000 + text.length * 90);
    });
  } catch {
    // No TTS engine, or it was interrupted: the answer is still on the HUD.
  }
}

/**
 * Speaks `text`. `clip` is the Mac's audio for exactly this text if we already have it; otherwise
 * `fetchClip` is asked for one. With neither, or if playing fails, the built-in voice speaks.
 * Resolves when the speech has finished. Never rejects.
 */
export async function speak(
  text: string,
  opts: { clip?: SpeechClip; fetchClip?: (text: string) => Promise<SpeechClip | null> } = {},
): Promise<void> {
  if (!text.trim()) return;
  const clip = opts.clip ?? (await opts.fetchClip?.(text)) ?? null;
  if (clip) {
    try {
      await play(clip);
      return;
    } catch {
      // Fall through to the built-in voice.
    }
  }
  await builtInVoice(text);
}

export function stopSpeaking(): void {
  try {
    playing?.pause();
    if (NATIVE) void TextToSpeech.stop();
    else if ('speechSynthesis' in window) speechSynthesis.cancel();
  } catch {
    // Nothing was speaking.
  }
}
