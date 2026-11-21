"""Text to speech on the Mac with Kokoro (mlx-audio): a natural voice instead of the phone's built-in one.

The phone plays the audio this returns, and falls back to Android's own voice if this isn't
available. Warm, a sentence takes 0.05-0.3 s to generate (measured on Kien's Mac, 2026-11-20).
"""
import io
import wave

import numpy as np

import config

SAMPLE_RATE = 24_000
# Kokoro pads its output with silence; trimmed to this much at each end so answers start promptly.
EDGE_SILENCE_S = 0.06
SILENCE_LEVEL = 0.01
MAX_CHARS = 800

_model = None
_state = "off" if not config.TTS_VOICE else "not loaded"  # off | not loaded | loading | ready | error: ...


def state() -> str:
    return _state


def _load():
    global _model, _state
    if _model is None:
        _state = "loading"
        try:
            from mlx_audio.tts.utils import load_model  # slow import: only when speech is first needed

            _model = load_model(config.TTS_MODEL)
        except Exception as e:  # noqa: BLE001 - reported through /api/health
            _state = f"error: {e.__class__.__name__}: {e}"[:200]
            raise
    return _model


def _trim(audio: np.ndarray) -> np.ndarray:
    loud = np.flatnonzero(np.abs(audio) > SILENCE_LEVEL)
    if not len(loud):
        return audio
    pad = int(EDGE_SILENCE_S * SAMPLE_RATE)
    return audio[max(0, loud[0] - pad) : loud[-1] + pad]


def synthesize(text: str) -> bytes:
    """`text` as a WAV file (24 kHz, mono, 16-bit). Blocking: call it through gpu.run()."""
    global _state
    if _state == "off":
        raise RuntimeError("speech is turned off (TTS_VOICE is empty)")
    model = _load()
    try:
        parts = [
            np.array(r.audio, dtype=np.float32).reshape(-1)
            for r in model.generate(text=text[:MAX_CHARS], voice=config.TTS_VOICE, speed=config.TTS_SPEED, lang_code=config.TTS_VOICE[:1])
        ]
    except Exception as e:  # noqa: BLE001
        _state = f"error: {e.__class__.__name__}: {e}"[:200]
        raise
    _state = "ready"
    audio = _trim(np.concatenate(parts)) if parts else np.zeros(1, dtype=np.float32)
    pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2")
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm.tobytes())
    return out.getvalue()


def warm_up() -> None:
    """Loads the voice at startup (downloads it the first time, about 350 MB) so the first answer isn't slow."""
    if _state == "off":
        return
    try:
        synthesize("Ready.")
    except Exception:  # noqa: BLE001 - state() already says what went wrong
        pass
