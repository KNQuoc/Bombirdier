"""Speech to text on the Mac with mlx-whisper (Apple Silicon). Audio never leaves this machine."""
import threading

import config

AVIATION_PROMPT = (
    "Aviation voice commands at Wood County Regional Airport, Bowling Green, Ohio. BGSU. Piper Archer, Piper Seminole, "
    "Skyhawk, helicopters, jets. Runway two eight, runway one zero. Downwind, base, final, upwind, crosswind. "
    "Toledo Approach. Show me the list. Next page. Sort by altitude. Zoom the radar."
)

_state = "not loaded"  # not loaded | loading | ready | error: ...
_lock = threading.Lock()


def state() -> str:
    return _state


def _prompt(callsigns: list[str]) -> str:
    """Whisper spells better when it has seen the words: the callsigns around go into the prompt."""
    names = ", ".join(c for c in callsigns[:25] if c)
    return f"{AVIATION_PROMPT} Callsigns: {names}." if names else AVIATION_PROMPT


def transcribe(path: str, callsigns: list[str] | None = None) -> str:
    """Blocking (run it in a thread). The first call loads the model, and downloads it if needed (about 1.6 GB)."""
    global _state
    import mlx_whisper  # imported late: it's slow to import and the server should start right away

    with _lock:  # one transcription at a time: they all use the same GPU
        if _state != "ready":
            _state = "loading"
        try:
            result = mlx_whisper.transcribe(
                path,
                path_or_hf_repo=config.WHISPER_MODEL,
                initial_prompt=_prompt(callsigns or []),
                language="en",
                temperature=0.0,
                condition_on_previous_text=False,
            )
        except Exception as e:  # noqa: BLE001 - reported through /api/health
            _state = f"error: {e.__class__.__name__}: {e}"[:200]
            raise
        _state = "ready"
    text = (result.get("text") or "").strip()
    # With silence or noise Whisper tends to echo its prompt back.
    return "" if text and text in AVIATION_PROMPT else text


def warm_up() -> None:
    """Loads the model in the background at startup so the first question isn't the slow one."""
    import os
    import struct
    import tempfile
    import wave

    fd, path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        with wave.open(path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes(struct.pack("<h", 0) * 16000)  # one second of silence
        transcribe(path)
    except Exception:  # noqa: BLE001 - state() already says what went wrong
        pass
    finally:
        os.unlink(path)
