"""Live radio feeds: one worker per feed that is actually in use.

    stream --ffmpeg--> 16 kHz audio --CallSplitter--> one call --Whisper--> text --radio_parse--> event

Feeds are listed in feeds.json. A LiveATC feed needs its stream address pasted in by hand
(`streamUrl`): find the feed on liveatc.net, its "listen" link downloads a small .pls file, and the
`File1=` line in that is the address. Nothing here guesses or scrapes addresses.

Being a polite listener (LiveATC's terms don't allow third-party use; this is private, personal use):
one connection per feed, only while someone is listening (a worker starts when the phone asks for
that feed's calls and stops two minutes after it last asked), a reconnect at most every 30 seconds,
an honest User-Agent, nothing written to disk beyond a temporary file per call that is deleted at
once, and no redistribution.
"""
import asyncio
import json
import os
import tempfile
import time
import wave
from collections import deque
from pathlib import Path

import config
import gpu
import radio_parse
import transcribe
from splitter import SAMPLE_RATE, CallSplitter

# FEEDS_FILE in the environment points at another list (the tests use one with a local recording).
FEEDS_FILE = Path(os.environ.get("FEEDS_FILE") or config.HERE / "feeds.json")
STOP_AFTER_IDLE_S = 120
RECONNECT_AFTER_S = 30
ONLINE_WITHIN_S = 15  # audio arrived this recently = the feed is up
EVENTS_KEPT = 200
BUFFER_S = 60  # recent audio kept in memory, for replaying to the phone (Phase 5)
READ_BYTES = 4800  # 150 ms
BACKLOG_MAX = 4  # calls waiting for Whisper; older ones are dropped rather than fall behind
CHECK_TIMEOUT_S = 6

_event_id = 0


def _next_event_id() -> int:
    global _event_id
    _event_id += 1
    return _event_id


def _ffmpeg_input(cfg: dict) -> list[str] | None:
    """ffmpeg's input arguments for a feed, or None if it isn't set up."""
    kind = cfg.get("kind")
    if kind in ("liveatc", "stream"):
        url = (cfg.get("streamUrl") or "").strip()
        # Only plain web streams: ffmpeg understands many other "protocols" a config file shouldn't reach.
        if not url.lower().startswith(("http://", "https://")):
            return None
        return ["-user_agent", config.USER_AGENT, "-i", url]
    if kind == "file":  # a local recording played in a loop at real speed: for testing
        path = cfg.get("path") or ""
        return ["-re", "-stream_loop", "-1", "-i", path] if os.path.isfile(path) else None
    return None


class Feed:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.id: str = cfg["id"]
        self.status = "idle"  # idle | connecting | online | offline
        self.events: deque[dict] = deque(maxlen=EVENTS_KEPT)
        self.heard: dict[str, tuple[float, int]] = {}  # callsign token -> (when, event id)
        self.audio: deque[bytes] = deque(maxlen=BUFFER_S * SAMPLE_RATE * 2 // READ_BYTES)
        self.last_audio_at = 0.0
        self.last_call_at: float | None = None
        self.last_used_at = 0.0
        self.error = ""
        self._task: asyncio.Task | None = None
        self._backlog = 0

    @property
    def configured(self) -> bool:
        return _ffmpeg_input(self.cfg) is not None

    def describe(self) -> dict:
        return {
            "id": self.id,
            "name": self.cfg.get("name", self.id),
            "kind": self.cfg.get("kind"),
            "freqs": self.cfg.get("freqs", []),
            "configured": self.configured,
            "status": self.current_status(),
            "lastCallAt": self.last_call_at,
            "error": self.error or None,
        }

    def current_status(self) -> str:
        if self.status == "online" and time.time() - self.last_audio_at > ONLINE_WITHIN_S:
            return "connecting"  # connected, but nothing has come through for a while
        return self.status

    def use(self) -> None:
        """Someone wants this feed: start it if it isn't running, and keep it from idling out."""
        self.last_used_at = time.time()
        if self.configured and (self._task is None or self._task.done()):
            self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        self._task = None
        self.status = "idle"

    async def _run(self) -> None:
        """Connect, listen until nobody has asked for two minutes, reconnect (slowly) if it drops."""
        try:
            while time.time() - self.last_used_at < STOP_AFTER_IDLE_S:
                self.status = "connecting"
                started = time.time()
                await self._listen()
                if time.time() - self.last_used_at >= STOP_AFTER_IDLE_S:
                    break
                self.status = "offline"
                # Never hammer a stream that is down: at most one attempt per RECONNECT_AFTER_S.
                await asyncio.sleep(max(1.0, RECONNECT_AFTER_S - (time.time() - started)))
        finally:
            self.status = "idle"

    async def _listen(self) -> None:
        args = ["ffmpeg", "-nostdin", "-loglevel", "error", *(_ffmpeg_input(self.cfg) or []), "-vn", "-f", "s16le", "-ac", "1", "-ar", str(SAMPLE_RATE), "-"]
        proc = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        splitter = CallSplitter()
        try:
            while time.time() - self.last_used_at < STOP_AFTER_IDLE_S:
                try:
                    chunk = await asyncio.wait_for(proc.stdout.read(READ_BYTES), timeout=ONLINE_WITHIN_S)
                except asyncio.TimeoutError:
                    continue  # still connected, just nothing coming
                if not chunk:
                    break  # the stream ended or never opened
                self.status = "online"
                self.error = ""
                self.last_audio_at = time.time()
                self.audio.append(chunk)
                for call in splitter.feed(chunk):
                    self._queue(call)
            if proc.returncode is None and proc.stdout.at_eof():
                await proc.wait()
            if proc.returncode not in (None, 0):
                self.error = ((await proc.stderr.read()).decode(errors="replace").strip().splitlines() or ["stream ended"])[-1][:200]
        finally:
            if proc.returncode is None:
                proc.kill()
                await proc.wait()

    def _queue(self, call: bytes) -> None:
        if self._backlog >= BACKLOG_MAX:
            return  # Whisper is behind (or busy with a voice question): skip this call, stay current
        self._backlog += 1
        asyncio.create_task(self._transcribe(call, time.time()))

    async def _transcribe(self, call: bytes, heard_at: float) -> None:
        fd, path = tempfile.mkstemp(suffix=".wav")
        try:
            with os.fdopen(fd, "wb") as f, wave.open(f, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(SAMPLE_RATE)
                w.writeframes(call)
            text = await gpu.run(transcribe.transcribe, path, around(), transcribe.RADIO_PROMPT)
        except Exception:  # noqa: BLE001 - one bad call isn't worth stopping the feed for
            text = ""
        finally:
            self._backlog -= 1
            os.unlink(path)  # calls are never kept
        if not text:
            return
        parsed = radio_parse.parse(text)
        event = {"id": _next_event_id(), "feedId": self.id, "ts": heard_at, "text": text, "seconds": round(len(call) / (SAMPLE_RATE * 2), 1), **parsed}
        self.events.append(event)
        self.last_call_at = heard_at
        for token in parsed["callsignTokens"]:
            self.heard[token] = (heard_at, event["id"])

    async def check(self) -> str:
        """Is the stream there? A quick look without starting to listen. Running feeds just report their status."""
        if self._task and not self._task.done():
            return self.current_status()
        source = _ffmpeg_input(self.cfg)
        if not source:
            return "offline"
        args = ["ffmpeg", "-nostdin", "-loglevel", "error", *source, "-t", "1", "-vn", "-f", "s16le", "-ac", "1", "-ar", "8000", "-"]
        proc = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        try:
            got = await asyncio.wait_for(proc.stdout.read(800), timeout=CHECK_TIMEOUT_S)
        except asyncio.TimeoutError:
            got = b""
        finally:
            if proc.returncode is None:
                proc.kill()
                await proc.wait()
        return "online" if got else "offline"


# ---- the feeds, and what the phone told us is flying -------------------------------------------------

_feeds: dict[str, Feed] = {}
_around: tuple[float, list[str]] = (0.0, [])
AROUND_TTL_S = 30


def load() -> dict[str, Feed]:
    """Reads feeds.json. A broken file means no feeds, not a server that won't start."""
    global _feeds
    try:
        configs = json.loads(FEEDS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        configs = []
    _feeds = {c["id"]: Feed(c) for c in configs if isinstance(c, dict) and isinstance(c.get("id"), str)}
    return _feeds


def all_feeds() -> list[Feed]:
    return list(_feeds.values())


def get(feed_id: str) -> Feed | None:
    return _feeds.get(feed_id)


def set_around(callsigns: list[str]) -> None:
    """The callsigns the phone can see, so Whisper knows which names to expect."""
    global _around
    clean = [c.strip().upper() for c in callsigns if isinstance(c, str) and 2 <= len(c.strip()) <= 10]
    _around = (time.time(), clean[:200])


def around() -> list[str]:
    at, callsigns = _around
    return [radio_parse.spoken_form(c) for c in callsigns[:40]] if time.time() - at <= AROUND_TTL_S else []


async def idle_watch() -> None:
    """Stops feeds nobody has asked about for a while. Runs for the life of the server."""
    while True:
        await asyncio.sleep(10)
        for feed in all_feeds():
            if feed._task and not feed._task.done() and time.time() - feed.last_used_at >= STOP_AFTER_IDLE_S:
                await feed.stop()


def heard(callsign: str) -> dict | None:
    """The most recent call that named this plane, on any feed: {feedId, lastHeardAt, eventId}."""
    want = "".join(ch for ch in callsign.upper() if ch.isalnum())
    best = None
    for feed in all_feeds():
        for token, (at, event_id) in feed.heard.items():
            # A tail said in short ("1BG", "901BG") counts for the full registration.
            if (token == want or (len(token) >= 3 and want.endswith(token))) and (best is None or at > best["lastHeardAt"]):
                best = {"feedId": feed.id, "lastHeardAt": at, "eventId": event_id}
    return best
