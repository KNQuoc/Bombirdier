// Records one spoken question from the microphone: starts on demand, stops by itself when you
// stop talking. Audio is sent as base64 in JSON (multipart/Blob is unreliable through Capacitor's
// native HTTP bridge).

/**
 * Speech is whatever is clearly louder than the background. Measured on a Pixel 7 (2026-11-21): with
 * Android's noise suppression on, a quiet room reads about 0.0001 RMS and speech from across a desk
 * 0.005-0.03, so a fixed threshold tuned on a laptop (0.025) heard nothing. The threshold follows the
 * background level instead, within these bounds.
 */
const SPEECH_OVER_NOISE = 4;
const MIN_SPEECH_LEVEL = 0.003;
const MAX_SPEECH_LEVEL = 0.05;
/** After speech, this much quiet ends the question. */
const SILENCE_MS = 1300;
/** If nobody has said anything by now, give up. */
const NO_SPEECH_MS = 5000;
const MAX_MS = 10_000;
const LEVEL_EVERY_MS = 80;

export type Recording = {
  audio: string;
  mime: string;
  /** Did the loudness meter notice speech? Sent either way: Whisper is the better judge of silence. */
  heardSpeech: boolean;
  /** Loudest level seen (RMS, 0..1), for the log. */
  peak: number;
  ms: number;
};

export type ActiveRecording = {
  /** The recording, or null if it was cancelled or came out empty. Rejects if the mic can't be opened. */
  done: Promise<Recording | null>;
  /** Stop now and send what there is. */
  stop: () => void;
  /** Throw the recording away. */
  cancel: () => void;
};

/** Asks for the microphone once, up front (the Android permission prompt), then lets go of it. */
export async function requestMicrophone(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return true;
  } catch {
    return false;
  }
}

let audioContext: AudioContext | null = null;
const context = () => (audioContext ??= new AudioContext());

/** A short tone: "I'm listening" (rising) or "got it" (falling). The headset has no other feedback. */
export function beep(kind: 'start' | 'stop'): void {
  try {
    const ctx = context();
    void ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const [from, to] = kind === 'start' ? [660, 990] : [880, 550];
    osc.frequency.setValueAtTime(from, ctx.currentTime);
    osc.frequency.linearRampToValueAtTime(to, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.16);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.18);
  } catch {
    // No audio output: the HUD still shows the state.
  }
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  // In chunks: String.fromCharCode(...bytes) overflows the stack on anything but tiny buffers.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function record(): ActiveRecording {
  let stopNow: () => void = () => {};
  let cancelled = false;

  const done = (async (): Promise<Recording | null> => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m));
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);

    // Loudness meter, to notice when the talking starts and stops.
    const ctx = context();
    void ctx.resume();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const startedAt = performance.now();
    let heardSpeech = false;
    let quietSince = startedAt;
    let peak = 0;
    /** Background level: drops to any quieter reading at once, creeps up slowly otherwise. */
    let noise = Infinity;

    const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
    const meter = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const s of samples) sum += s * s;
      const level = Math.sqrt(sum / samples.length);
      const now = performance.now();
      peak = Math.max(peak, level);
      noise = Math.min(level, noise === Infinity ? level : noise * 1.005 + 0.00001);
      const speechLevel = Math.min(MAX_SPEECH_LEVEL, Math.max(MIN_SPEECH_LEVEL, noise * SPEECH_OVER_NOISE));
      if (level >= speechLevel) {
        heardSpeech = true;
        quietSince = now;
      }
      const finished = heardSpeech ? now - quietSince >= SILENCE_MS : now - startedAt >= NO_SPEECH_MS;
      if (finished || now - startedAt >= MAX_MS) stopNow();
    }, LEVEL_EVERY_MS);
    stopNow = () => recorder.state !== 'inactive' && recorder.stop();

    recorder.start();
    await stopped;
    clearInterval(meter);
    source.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    if (cancelled || !chunks.length) return null;
    const blob = new Blob(chunks, { type: recorder.mimeType || mime || 'audio/webm' });
    return { audio: toBase64(await blob.arrayBuffer()), mime: blob.type, heardSpeech, peak, ms: Math.round(performance.now() - startedAt) };
  })();

  return {
    done,
    stop: () => stopNow(),
    cancel: () => {
      cancelled = true;
      stopNow();
    },
  };
}
