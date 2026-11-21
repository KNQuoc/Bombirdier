"""Speech to text on the Mac with mlx-whisper (Apple Silicon). Audio never leaves this machine."""
import config

# Vocabulary only, no whole commands: a prompt full of commands makes Whisper "hear" them in noise.
AVIATION_PROMPT = (
    "Aviation talk at Wood County Regional Airport, Bowling Green, Ohio. BGSU, Piper Archer, Piper Seminole, Skyhawk, "
    "helicopters, jets, radar, runway two eight, runway one zero, downwind, base, final, upwind, crosswind, Toledo Approach."
)
# For radio calls (feeds.py): words to expect, never whole example calls. With examples in the prompt,
# real audio came back as the examples ("Skyhawk 4 Xray 276, cleared ILS runway 25" on a Center
# frequency that was working airliners), and SkyWest flights were written down as Skyhawks.
_AIRLINE_TALK = (
    "Airline callsigns: Delta, United, American, Southwest, SkyWest, Endeavor, Brickyard, Envoy, Blue Streak, Jazz, "
    "Air Canada, FedEx, UPS, ExecJet, Frontier, Spirit Wings, JetBlue, Allegiant, Air Wisconsin, Piedmont, Commutair. "
    "Climb and maintain flight level three five zero, descend and maintain one zero thousand, direct, heading, "
    "altimeter three zero two six, squawk, radar contact, contact Center, contact Approach, contact Tower, "
    "expect the RNP approach, cleared ILS approach, runway one zero left, two eight right."
)
_LIGHT_TALK = (
    "Light aircraft say their type and tail number in the phonetic alphabet: November, Archer, Seminole, Cessna, "
    "Skyhawk, Warrior, Cirrus, Citation, King Air. Left downwind, right base, final, upwind, crosswind, short final, "
    "departing, entering the pattern, clear of the runway, touch and go, full stop, runway two eight, one zero, one eight, three six."
)
RADIO_TALK = {
    # A controller working airliners (Approach at a big airport, Center).
    "airline": _AIRLINE_TALK,
    # A tower or approach that works both.
    "mixed": f"{_AIRLINE_TALK} {_LIGHT_TALK}",
    # Pilots announcing themselves at an airport with no tower.
    "pattern": f"Wood County traffic, Bowling Green. {_LIGHT_TALK}",
}


def radio_prompt(name: str, talk: str = "mixed") -> str:
    """Whisper's prompt for one radio feed: who is talking, and the words to expect there."""
    return f"Air traffic control radio, {name}. {RADIO_TALK.get(talk, RADIO_TALK['mixed'])}"


# Kept for anything that still asks for one prompt for all radio.
RADIO_PROMPT = radio_prompt("Toledo Approach")

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


def _prompt(callsigns: list[str], base: str = "") -> str:
    """Whisper spells better when it has seen the words: the callsigns around go into the prompt."""
    names = [c for c in callsigns[:25] if c]
    if base:
        # Radio calls: the names follow as more of the same kind of talk, with no label. A label gets
        # written into transcripts ("Callsigns, 945, contact Cleveland Center" was heard on a real
        # call whose airline name Whisper couldn't make out).
        return f"{base} {'. '.join(names)}." if names else base
    return f"{AVIATION_PROMPT} Callsigns: {', '.join(names)}." if names else AVIATION_PROMPT


def transcribe(path: str, callsigns: list[str] | None = None, prompt: str = "") -> str:
    """Blocking: call it through gpu.run(). The first call loads the model, and downloads it if needed (about 1.6 GB)."""
    global _state
    import mlx_whisper  # imported late: it's slow to import and the server should start right away

    if _state != "ready":
        _state = "loading"
    try:
        result = mlx_whisper.transcribe(
            path,
            path_or_hf_repo=config.WHISPER_MODEL,
            initial_prompt=_prompt(callsigns or [], prompt),
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
    # Whisper reading its own prompt back. For a voice question: a long stretch of it. For a radio
    # call: a run of the prompt's vocabulary with nothing else in it (a real call has a callsign or
    # a number that the vocabulary list doesn't).
    said = _prompt(callsigns or [], prompt)
    if not prompt and len(text) >= ECHO_MIN_CHARS and text in said:
        return ""
    if prompt and _is_echo(text, prompt):
        return ""
    return text


def _words(text: str) -> str:
    return " ".join("".join(ch if ch.isalnum() else " " for ch in text.lower()).split())


def _is_echo(text: str, prompt: str) -> bool:
    """Three words or more that appear, in that order and together, in the prompt's vocabulary."""
    words = _words(text)
    return len(words.split()) >= 3 and f" {words} " in f" {_words(prompt)} "


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
