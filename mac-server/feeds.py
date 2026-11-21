"""Live radio feeds.

    audio --CallSplitter--> one call --Whisper--> text --radio_parse--> event

Feeds are listed in feeds.json. Where the audio comes from depends on the feed's kind:

  tab      The feed plays in its own website's player in a Chrome tab, and the capture page
           (/capture) sends that tab's sound here. This is how LiveATC feeds are used: their pages
           offer an in-browser player and say the streams may not be used in third-party products,
           so nothing here connects to their streams or knows their addresses. You listen through
           their player; this Mac transcribes what is playing.
  stream   A plain web audio stream this Mac may connect to (your own receiver, for instance). One
           ffmpeg connection, only while someone is listening: it starts when the phone asks for the
           feed's calls, stops two minutes after it last asked, and reconnects at most every 30 s.
  file     A local recording played in a loop at real speed, for testing.

Nothing is written to disk beyond a temporary file per call, deleted as soon as it is transcribed.
"""
import asyncio
import json
import math
import os
import re
import tempfile
import time
import wave
from collections import deque
from pathlib import Path

import config
import gpu
import radio_parse
import transcribe
from splitter import SAMPLE_RATE, CallSplitter, _rms

# FEEDS_FILE in the environment points at another list (the tests use one with a local recording).
FEEDS_FILE = Path(os.environ.get("FEEDS_FILE") or config.HERE / "feeds.json")
STOP_AFTER_IDLE_S = 120
RECONNECT_AFTER_S = 30
ONLINE_WITHIN_S = 15  # audio arrived this recently = the feed is up
LISTENER_QUEUE = 40  # chunks waiting for one listener's encoder (10 s of a tab feed)
LISTEN_PREROLL_S = 2.5  # recent audio a new listener is given at once, so playback starts quickly
LISTEN_BITRATE = "128k"  # generous for speech: more bytes per second fills the player's start-up buffer sooner
LISTEN_IDLE_S = 20  # a listener's stream ends after this long with no audio arriving at all
LEVELS_KEPT = 300  # a bit over a minute of pushed chunks
TAB_ONLINE_WITHIN_S = 5  # a captured tab sends audio constantly; a gap this long means capture stopped
EVENTS_KEPT = 200
BUFFER_S = 60  # recent audio kept in memory, for replaying to the phone (Phase 5)
READ_BYTES = 4800  # 150 ms
BACKLOG_MAX = 4  # calls waiting for Whisper; older ones are dropped rather than fall behind
CHECK_TIMEOUT_S = 6

# Call ids only ever go up, across restarts too: the phone and the capture page ask for "everything
# after id N", and a counter that started again at 1 would hide every new call from them until it
# caught up with their N. (Seen live: a restart made real calls invisible on the capture page.)
_event_id = int(time.time() * 1000)


def _next_event_id() -> int:
    global _event_id
    _event_id += 1
    return _event_id


def _db(rms: float) -> float | None:
    return round(20 * math.log10(rms / 32768), 1) if rms >= 1 else None


def _ffmpeg_input(cfg: dict) -> list[str] | None:
    """ffmpeg's input arguments for a feed, or None if it isn't set up."""
    kind = cfg.get("kind")
    if kind == "stream":
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
        # A tab feed has no worker: its audio is pushed in by the capture page.
        self.is_tab = cfg.get("kind") == "tab"
        self._splitter = CallSplitter()
        # How loud each recent chunk of pushed audio was: tells a quiet frequency (the feed's own
        # background, or digital silence) from a tab whose sound isn't coming through at all.
        self._levels: deque[tuple[float, float]] = deque(maxlen=LEVELS_KEPT)
        # People listening to this feed on the phone: each gets the audio as it arrives.
        self._listeners: set[asyncio.Queue] = set()

    @property
    def configured(self) -> bool:
        return self.is_tab or _ffmpeg_input(self.cfg) is not None

    def push(self, pcm: bytes) -> None:
        """Audio from the capture page (16 kHz, mono, 16-bit): the tab feed's way in."""
        now = time.time()
        if now - self.last_audio_at > TAB_ONLINE_WITHIN_S:
            # Capture has just (re)started: whatever half a call was left over from before is not
            # part of what comes next.
            self._splitter = CallSplitter()
            self.audio.clear()
        self.status = "online"
        self.error = ""
        self.last_audio_at = now
        self.audio.append(pcm)
        self._fan_out(pcm)
        self._levels.append((now, _rms(pcm)))
        for call in self._splitter.feed(pcm):
            self._queue(call)

    def _fan_out(self, pcm: bytes) -> None:
        for queue in self._listeners:
            if queue.full():
                queue.get_nowait()  # a listener that can't keep up loses the oldest audio, not the newest
            queue.put_nowait(pcm)

    async def listen(self):
        """This feed's audio from now on, as an MP3 stream (what the phone's audio player is given).

        One small ffmpeg per listener, fed from the audio already arriving here: listening adds no
        connection to the feed's source, and nothing is stored.
        """
        queue: asyncio.Queue = asyncio.Queue(maxsize=LISTENER_QUEUE)
        # Start with the last couple of seconds: a player won't begin until it has collected a fair
        # amount of data, and waiting for that much live audio took 9 s on the phone. The price is
        # that the listener hears everything that much later, which nobody notices.
        recent = list(self.audio)
        have = 0
        start = len(recent)
        while start > 0 and have < LISTEN_PREROLL_S * SAMPLE_RATE * 2:
            start -= 1
            have += len(recent[start])
        if time.time() - self.last_audio_at <= TAB_ONLINE_WITHIN_S:
            for chunk in recent[start:]:
                queue.put_nowait(chunk)
        self._listeners.add(queue)
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-nostdin", "-loglevel", "error", "-fflags", "nobuffer",
            "-f", "s16le", "-ar", str(SAMPLE_RATE), "-ac", "1", "-i", "pipe:0",
            "-c:a", "libmp3lame", "-b:a", LISTEN_BITRATE, "-flush_packets", "1", "-f", "mp3", "pipe:1",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )  # fmt: skip

        async def pump() -> None:
            try:
                while True:
                    proc.stdin.write(await queue.get())
                    await proc.stdin.drain()
            except (ConnectionError, asyncio.CancelledError):
                pass

        pumping = asyncio.create_task(pump())
        try:
            while True:
                self.use()  # someone listening keeps a stream feed connected
                try:
                    data = await asyncio.wait_for(proc.stdout.read(4096), timeout=LISTEN_IDLE_S)
                except asyncio.TimeoutError:
                    break  # nothing arriving at all (capture stopped): end rather than hang forever
                if not data:
                    break
                yield data
        finally:
            self._listeners.discard(queue)
            pumping.cancel()
            if proc.returncode is None:
                proc.kill()
                await proc.wait()

    def describe(self) -> dict:
        return {
            "id": self.id,
            "name": self.cfg.get("name", self.id),
            "kind": self.cfg.get("kind"),
            "freqs": self.cfg.get("freqs", []),
            # Where to open the feed's own player, and what it is called there (tab feeds).
            "page": self.cfg.get("page"),
            "listenTo": self.cfg.get("listenTo"),
            "configured": self.configured,
            "status": self.current_status(),
            "lastCallAt": self.last_call_at,
            # Loudness of what is arriving, in dB below full scale (0 = as loud as it gets, None =
            # nothing or pure digital silence): right now, and the loudest in the last minute.
            "levelDb": _db(self._levels[-1][1]) if self._levels and time.time() - self._levels[-1][0] < TAB_ONLINE_WITHIN_S else None,
            "peakDb": _db(max((rms for at, rms in self._levels if time.time() - at <= 60), default=0.0)),
            "error": self.error or None,
        }

    def current_status(self) -> str:
        if self.is_tab:
            # Captured audio arrives several times a second, silence included. None lately = capture stopped.
            if not self.last_audio_at:
                return "idle"
            return "online" if time.time() - self.last_audio_at <= TAB_ONLINE_WITHIN_S else "offline"
        if self.status == "online" and time.time() - self.last_audio_at > ONLINE_WITHIN_S:
            return "connecting"  # connected, but nothing has come through for a while
        return self.status

    def use(self) -> None:
        """Someone wants this feed: start it if it isn't running, and keep it from idling out."""
        self.last_used_at = time.time()
        if self.is_tab:
            return
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
                self._fan_out(chunk)
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
            prompt = transcribe.radio_prompt(self.cfg.get("name", self.id), self.cfg.get("talk", "mixed"))
            text = await gpu.run(transcribe.transcribe, path, around(self.id), prompt)
        except Exception:  # noqa: BLE001 - one bad call isn't worth stopping the feed for
            text = ""
        finally:
            self._backlog -= 1
            os.unlink(path)  # calls are never kept
        # Noise sometimes comes back as a stray mark ("!") or a lone word ("The", for 25 seconds of
        # static) rather than nothing: that isn't a call. Speech is at least a word a second.
        seconds = len(call) / (SAMPLE_RATE * 2)
        words = re.findall(r"[A-Za-z0-9]+", text)
        if len(words) < 2 or (seconds >= 6 and len(words) / seconds < 0.5):
            return
        parsed = radio_parse.parse(text)
        event = {"id": _next_event_id(), "feedId": self.id, "ts": heard_at, "text": text, "seconds": round(len(call) / (SAMPLE_RATE * 2), 1), **parsed}
        self.events.append(event)
        self.last_call_at = heard_at
        for token in parsed["callsignTokens"]:
            self.heard[token] = (heard_at, event["id"])

    async def check(self) -> str:
        """Is the stream there? A quick look without starting to listen. Running feeds just report their status."""
        if self.is_tab or (self._task and not self._task.done()):
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
_around_by_feed: dict[str, list[str]] = {}
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


def _clean(callsigns) -> list[str]:
    return [c.strip().upper() for c in callsigns if isinstance(c, str) and 2 <= len(c.strip()) <= 10][:200] if isinstance(callsigns, list) else []


def set_around(callsigns: list[str], by_feed: dict | None = None) -> None:
    """The callsigns the phone can see, so Whisper knows which names to expect.

    `by_feed` narrows it per feed (the planes that controller is probably working): a Center sector
    150 km away talks to different planes than the ones nearest the user.
    """
    global _around, _around_by_feed
    _around = (time.time(), _clean(callsigns))
    _around_by_feed = {str(k): _clean(v) for k, v in (by_feed or {}).items()} if isinstance(by_feed, dict) else {}


def around(feed_id: str | None = None) -> list[str]:
    at, callsigns = _around
    if time.time() - at > AROUND_TTL_S:
        return []
    # That feed's own planes first, then the ones around the user, without repeats.
    names = list(dict.fromkeys(_around_by_feed.get(feed_id or "", []) + callsigns))
    return [radio_parse.spoken_form(c) for c in names[:40]]


async def idle_watch() -> None:
    """Stops feeds nobody has asked about for a while. Runs for the life of the server."""
    while True:
        await asyncio.sleep(10)
        for feed in all_feeds():
            if feed._task and not feed._task.done() and time.time() - feed.last_used_at >= STOP_AFTER_IDLE_S:
                await feed.stop()


def recent(feed_id: str | None, within_s: float = 300, limit: int = 12) -> list[dict]:
    """The latest calls on one feed (or on all of them), oldest first: for "what did they just say?"."""
    wanted = [get(feed_id)] if feed_id else all_feeds()
    now = time.time()
    events = [e for f in wanted if f for e in f.events if now - e["ts"] <= within_s]
    events.sort(key=lambda e: e["id"])
    return [{"feedId": e["feedId"], "agoS": round(now - e["ts"]), "text": e["text"], "callsignTokens": e["callsignTokens"]} for e in events[-limit:]]


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
