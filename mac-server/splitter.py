"""Cuts a continuous radio audio stream into individual calls.

A scanner feed is mostly silence (squelch closed) with bursts of speech. A call starts when the
audio rises clearly above the background for a moment and ends after a pause. Each call is then
transcribed on its own, which is both faster and more accurate than feeding Whisper a long stream.

Pure Python on purpose (no numpy): 16,000 samples a second is nothing, and the tests run without the
server's packages.
"""
from array import array
from collections import deque

SAMPLE_RATE = 16_000
FRAME_MS = 30
FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS // 1000
FRAME_BYTES = FRAME_SAMPLES * 2  # 16-bit mono

# Louder than this (RMS, out of 32768) can be speech; the real threshold follows the background.
MIN_SPEECH_RMS = 180
SPEECH_OVER_NOISE = 3.0
START_FRAMES = 3  # 90 ms of speech in a row starts a call
END_SILENCE_MS = 700  # this much quiet ends it
PRE_ROLL_MS = 240  # kept from before the start, so the first syllable isn't clipped
TAIL_MS = 200  # kept after the last speech
MIN_CALL_MS = 500  # shorter than this is a click or a squelch tail
MAX_CALL_MS = 25_000  # a stuck-open channel is cut into pieces this long


def _rms(frame: bytes) -> float:
    samples = array("h")
    samples.frombytes(frame)
    return (sum(s * s for s in samples) / len(samples)) ** 0.5 if samples else 0.0


class CallSplitter:
    """Feed it raw 16 kHz mono 16-bit audio in any chunk sizes; it hands back finished calls."""

    def __init__(self):
        self._pending = b""
        self._pre = deque(maxlen=PRE_ROLL_MS // FRAME_MS)
        self._call: list[bytes] = []
        self._in_call = False
        self._speech_run = 0
        self._silence_ms = 0
        self._speech_ms = 0
        self._noise = None  # background level: drops at once, creeps up slowly

    def feed(self, pcm: bytes) -> list[bytes]:
        """Returns the calls that ended inside this chunk, each as raw audio in the same format."""
        done: list[bytes] = []
        self._pending += pcm
        while len(self._pending) >= FRAME_BYTES:
            frame, self._pending = self._pending[:FRAME_BYTES], self._pending[FRAME_BYTES:]
            call = self._frame(frame)
            if call:
                done.append(call)
        return done

    def _frame(self, frame: bytes) -> bytes | None:
        level = _rms(frame)
        self._noise = level if self._noise is None else min(level, self._noise * 1.002 + 0.05)
        speech = level >= max(MIN_SPEECH_RMS, self._noise * SPEECH_OVER_NOISE)

        if not self._in_call:
            self._pre.append(frame)
            self._speech_run = self._speech_run + 1 if speech else 0
            if self._speech_run >= START_FRAMES:
                self._in_call = True
                self._call = list(self._pre)
                self._speech_ms = self._speech_run * FRAME_MS
                self._silence_ms = 0
                self._pre.clear()
            return None

        self._call.append(frame)
        if speech:
            self._speech_ms += FRAME_MS
            self._silence_ms = 0
        else:
            self._silence_ms += FRAME_MS
        too_long = len(self._call) * FRAME_MS >= MAX_CALL_MS
        if self._silence_ms < END_SILENCE_MS and not too_long:
            return None

        # Drop the silence that ended the call, apart from a short tail.
        keep = len(self._call) - max(0, (self._silence_ms - TAIL_MS) // FRAME_MS)
        audio = b"".join(self._call[:keep])
        long_enough = self._speech_ms >= MIN_CALL_MS
        self._in_call, self._call, self._speech_run, self._silence_ms, self._speech_ms = False, [], 0, 0, 0
        return audio if long_enough else None
