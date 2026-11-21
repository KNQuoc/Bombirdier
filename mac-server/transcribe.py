"""Speech to text on the Mac with mlx-whisper (Apple Silicon). Audio never leaves this machine."""
import config

# Vocabulary only, no whole commands: a prompt full of commands makes Whisper "hear" them in noise.
AVIATION_PROMPT = (
    "Aviation talk at Wood County Regional Airport, Bowling Green, Ohio. BGSU, Piper Archer, Piper Seminole, Skyhawk, "
    "helicopters, jets, radar, runway two eight, runway one zero, downwind, base, final, upwind, crosswind, Toledo Approach."
)
# Given silence or noise, Whisper makes things up: usually a word from its prompt, over and over.
# Its own per-segment figures give that away, and such segments are dropped.
NO_SPEECH_PROB = 0.6  # the model itself thinks nobody spoke
COMPRESSION_RATIO = 2.4  # text this repetitive isn't speech (Whisper's own default cut-off)
# Only a long match with the prompt counts as an echo: a short one ("jets", "final") is just someone
# saying a word that's in it.
ECHO_MIN_CHARS = 40

_state = "not loaded"  # not loaded | loading | ready | error: ...


def state() -> str:
    return _state


def _prompt(callsigns: list[str]) -> str:
    """Whisper spells better when it has seen the words: the callsigns around go into the prompt."""
    names = ", ".join(c for c in callsigns[:25] if c)
    return f"{AVIATION_PROMPT} Callsigns: {names}." if names else AVIATION_PROMPT


def transcribe(path: str, callsigns: list[str] | None = None) -> str:
    """Blocking: call it through gpu.run(). The first call loads the model, and downloads it if needed (about 1.6 GB)."""
    global _state
    import mlx_whisper  # imported late: it's slow to import and the server should start right away

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
    spoken = [
        s for s in result.get("segments") or []
        if s.get("no_speech_prob", 0.0) < NO_SPEECH_PROB and s.get("compression_ratio", 1.0) < COMPRESSION_RATIO
    ]
    text = " ".join((s.get("text") or "").strip() for s in spoken).strip()
    return "" if len(text) >= ECHO_MIN_CHARS and text in _prompt(callsigns or []) else text


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
