// Says the assistant's answer out loud. On the phone this is Android's own text-to-speech through
// a Capacitor plugin (speechSynthesis is unreliable in an Android WebView); in a desktop browser
// it falls back to speechSynthesis.

import { Capacitor } from '@capacitor/core';
import { TextToSpeech } from '@capacitor-community/text-to-speech';

const NATIVE = Capacitor.isNativePlatform();

/** Resolves when the speech has finished (or couldn't start). Never rejects. */
export async function speak(text: string): Promise<void> {
  if (!text.trim()) return;
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

export function stopSpeaking(): void {
  try {
    if (NATIVE) void TextToSpeech.stop();
    else if ('speechSynthesis' in window) speechSynthesis.cancel();
  } catch {
    // Nothing was speaking.
  }
}
