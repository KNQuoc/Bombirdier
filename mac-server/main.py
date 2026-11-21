"""Bombirdier's Mac server: the phone sends a spoken question, this answers it.

    phone --audio + context--> POST /api/voice/ask
        1. mlx-whisper turns the audio into text (on this Mac)
        2. rules.py answers commands with one obvious meaning straight away
        3. otherwise Aivana answers, and may return actions for the phone to carry out
        4. Kokoro speaks the answer (tts.py); the phone plays that audio
    phone <-- { transcript, answer, actions, speech }

Run:  ./run.sh      (http://127.0.0.1:8787; the phone reaches it over USB with `adb reverse tcp:8787 tcp:8787`)
"""
import base64
from datetime import datetime
import hmac
import ipaddress
import os
import re
import tempfile
import time
from collections import deque

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import asyncio

import airports
import config
import feeds
import flightinfo
import forecast
import opensky
import radiolog
import radiotalk
import gpu
import llm
import radio
import rules
import transcribe
import tts
from prompt import SYSTEM, context_text
from speech import aivana_trouble, describe
from tools import REPLY_SCHEMA, validate_actions

app = FastAPI(title="Bombirdier Mac server")

# Requests bigger than this are refused before they're read. A 10 s question is about 150 kB as base64.
MAX_BODY_BYTES = 12 * 1024 * 1024


def _is_ip(name: str) -> bool:
    try:
        ipaddress.ip_address(name)
        return True
    except ValueError:
        return False


def _host_name(header: str) -> str:
    """The host part of a Host header: "localhost:8787" -> "localhost", "[::1]:8787" -> "::1"."""
    h = header.strip().lower()
    return h[1 : h.index("]")] if h.startswith("[") and "]" in h else h.split(":")[0]


def _from_this_mac(request: Request) -> bool:
    client = request.client.host if request.client else ""
    return _is_ip(client) and ipaddress.ip_address(client).is_loopback


@app.middleware("http")
async def guard(request: Request, call_next):
    """Who may talk to this server. It can spend the Aivana credit, so it isn't open to whoever finds it.

    - Host must be "localhost" or a bare IP address. A web page that points its own domain name at
      127.0.0.1 (DNS rebinding) sends that domain as Host and is refused.
    - Oversized requests are refused unread.
    - Anything but the health check from another machine (Wi-Fi) needs the shared token. From this
      Mac (which is what the phone looks like over USB with adb reverse) it doesn't.
    """
    host = _host_name(request.headers.get("host", ""))
    if host != "localhost" and not _is_ip(host):
        return JSONResponse({"error": "unexpected Host header"}, status_code=400)
    length = request.headers.get("content-length", "")
    if length.isdigit() and int(length) > MAX_BODY_BYTES:
        return JSONResponse({"error": "request too large"}, status_code=413)
    # Everything except the health check: questions spend Aivana credit, and the radio endpoints
    # start a connection to someone else's stream.
    protected = (request.url.path.startswith("/api/") and request.url.path != "/api/health") or request.url.path == "/capture"
    # The live audio is played by an <audio> element, which can't send the token header: it shows
    # a one-time ticket instead (asked for, with the token, a moment earlier).
    m = re.fullmatch(r"/api/feeds/([^/]+)/audio", request.url.path)
    if m and request.method == "GET" and protected and not _from_this_mac(request):
        if not radio.redeem_ticket(m.group(1), request.query_params.get("ticket", "")):
            return JSONResponse({"error": "missing or used listening ticket"}, status_code=401)
        return await call_next(request)
    if request.method != "OPTIONS" and protected and not _from_this_mac(request):
        sent = request.headers.get("x-bombirdier-token", "")
        if not config.SERVER_TOKEN or not hmac.compare_digest(sent.encode(), config.SERVER_TOKEN.encode()):
            return JSONResponse({"error": "missing or wrong server token"}, status_code=401)
    return await call_next(request)


# The phone's requests are native (no CORS). This is for the desktop dev page. Added after the guard,
# so it wraps it: refusals carry CORS headers too and the dev page can read why.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5174", "http://127.0.0.1:5174", "https://localhost", "capacitor://localhost"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Recorded audio by container type. Anything else is handed to ffmpeg as .webm and usually still works.
SUFFIX = {"audio/webm": ".webm", "audio/ogg": ".ogg", "audio/mp4": ".m4a", "audio/aac": ".aac", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/mpeg": ".mp3"}
MAX_AUDIO_BYTES = 8 * 1024 * 1024  # 10 s of speech is about 100 kB; this is a guard, not a target

# The last few exchanges, so "why?" and "what about the other one?" make sense. Forgotten after a pause.
MEMORY_TURNS = 3
MEMORY_S = 120
_memory: deque[tuple[float, str, str]] = deque(maxlen=MEMORY_TURNS)


class SpeakRequest(BaseModel):
    text: str


class AskRequest(BaseModel):
    audio: str | None = None  # base64
    mime: str | None = None
    text: str | None = None  # a typed question instead of audio (desktop testing)
    context: dict = {}


app.include_router(radio.router)


@app.on_event("startup")
async def _startup() -> None:
    # Load both models in the background, one after the other, on the GPU thread.
    gpu.executor.submit(transcribe.warm_up)
    gpu.executor.submit(tts.warm_up)
    feeds.load()
    radiolog.enabled = config.RADIO_LOG
    asyncio.create_task(feeds.idle_watch())


@app.on_event("shutdown")
async def _shutdown() -> None:
    for feed in feeds.all_feeds():
        await feed.stop()  # don't leave an ffmpeg (and its connection) behind


async def _speech(text: str) -> dict | None:
    """{audio, mime} for `text` in the assistant's voice, or None if there's no voice (the phone uses its own)."""
    if not text.strip() or tts.state() != "ready":
        return None
    try:
        return {"audio": base64.b64encode(await gpu.run(tts.synthesize, text)).decode(), "mime": "audio/wav"}
    except Exception:  # noqa: BLE001 - tts.state() now says what went wrong
        return None


@app.post("/api/voice/speak")
async def speak(req: SpeakRequest) -> dict:
    """Speech for text the phone worded itself (counts over all the traffic, which only it has)."""
    return {"speech": await _speech(req.text)}


@app.get("/api/health")
async def health(request: Request) -> dict:
    # tokenNeeded tells a phone on Wi-Fi up front that its questions will be refused without the token.
    return {"ok": True, "whisper": transcribe.state(), "tts": tts.state(), "aivana": llm.available(), "tokenNeeded": not _from_this_mac(request)}


def _feed_names() -> dict[str, dict]:
    return {f.id: {"facility": f.cfg.get("facility") or f.id, "channel": f.cfg.get("channel") or f.cfg.get("name", f.id), "name": f.cfg.get("name", f.id)} for f in feeds.all_feeds() if f.configured}


@app.get("/api/radio/summary")
async def radio_summary(hours: float = 6):
    """What the written record of radio calls holds for the last `hours` (see radiolog.py)."""
    hours = max(0.1, min(72.0, hours))
    records = await asyncio.to_thread(radiolog.read, time.time() - hours * 3600)
    return {"logging": radiolog.enabled, "hours": hours, **radiolog.summary(records, _feed_names())}


# The card's lookups stop below this many OpenSky requests left today: the rest are for questions.
ORIGIN_KEEPS_REQUESTS = 60


@app.get("/api/flights/origin")
async def flight_origin(hex: str, helicopter: bool = False):
    """Where a plane with no route on file left from, for its card: the start of OpenSky's track
    of this flight, named after the airfield it is at. `origin` is null when that isn't known."""
    if not re.fullmatch(r"[0-9a-fA-F]{6}", hex):
        return JSONResponse({"error": "bad address"}, status_code=400)
    left_today = opensky.remaining
    if left_today and left_today.isdigit() and int(left_today) < ORIGIN_KEEPS_REQUESTS:
        return {"origin": None, "why": "few OpenSky requests left today"}
    took = await _takeoff({"id": hex.lower(), "kind": "helicopter" if helicopter else "plane"}, None)
    field = took.get("field") if took and took.get("fromGround") else None
    if not field:
        return {"origin": None}
    return {"origin": {**{k: field[k] for k in ("code", "name", "city", "lat", "lon", "kind")}, "exact": took["exact"], "at": took["at"].timestamp()}}


@app.get("/api/weather/wind")
async def wind(lat: float, lon: float):
    """The wind at the weather station nearest a point (for picking the runway the wind favors)."""
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return JSONResponse({"error": "bad position"}, status_code=400)
    report = await forecast.nearest("metar", lat, lon)
    if not report:
        return {"wind": None}
    direction = report.get("wdir")
    return {
        "wind": {
            "dirDeg": direction if isinstance(direction, (int, float)) else None,  # "VRB" = variable
            "speedKt": report.get("wspd") or 0,
            "gustKt": report.get("wgst") or None,
            "station": flightinfo.station_name(report),
            "distanceNm": round(report.get("distanceNm") or 0, 1),
            "raw": (report.get("rawOb") or "")[:200],
        }
    }


def _callsigns(ctx: dict) -> list[str]:
    planes = [ctx.get("focus")] + list(ctx.get("inView") or []) + list(ctx.get("bgsu") or [])
    rows = (ctx.get("list") or {}).get("rows") or []
    names = [p.get("callsign") or p.get("registration") for p in planes if p] + [r.get("name") for r in rows]
    return list(dict.fromkeys(n for n in names if n))


async def _transcribe(req: AskRequest) -> str:
    raw = base64.b64decode(req.audio or "", validate=False)
    if not raw or len(raw) > MAX_AUDIO_BYTES:
        return ""
    suffix = SUFFIX.get((req.mime or "").split(";")[0].strip().lower(), ".webm")
    fd, path = tempfile.mkstemp(suffix=suffix)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(raw)
        return await gpu.run(transcribe.transcribe, path, _callsigns(req.context))
    finally:
        os.unlink(path)  # recordings are never kept


async def _takeoff(plane: dict, prog: dict | None) -> dict | None:
    """When and where the plane took off: the phone's own sighting of it leaving a field it had
    stopped on, else OpenSky's track of this flight, else (for a plane with no route) the phone's
    sighting of it climbing away from somewhere. None if nobody has it.

    When the takeoff wasn't at the route's origin (or there is no route, as for most small planes),
    the place is the airfield the track starts at (airports.py), or failing that the nearest
    weather station.
    """
    seen = airports.seen_leaving(plane, prog)
    if seen and not seen["leaving"]:
        return seen
    took = opensky.takeoff(await opensky.track(plane), prog)
    if seen and not prog and not (took and took["fromGround"]):
        # All anyone has: the phone saw it climb away from somewhere (a touch-and-go, perhaps).
        return seen
    if took and took["fromGround"] and not took["atOrigin"]:
        field = airports.nearest(took["lat"], took["lon"], max_nm=6, helicopter=plane.get("kind") == "helicopter")
        if field:
            # On it, or only somewhere near it (first seen already climbing away)?
            low = took["altM"] is not None and field["elevationFt"] is not None and took["altM"] <= field["elevationFt"] * 0.3048 + 200
            took["field"] = field
            took["airport"] = airports.spoken(field)
            took["exact"] = field["distanceNm"] <= 3 and (took["onGround"] or low)
        else:
            station = await forecast.nearest("metar", took["lat"], took["lon"])
            took["near"] = flightinfo.station_name(station) if station and station.get("distanceNm", 99) <= 12 else None
    return took


async def _ask_aivana(question: str, ctx: dict) -> dict:
    now = time.time()
    messages: list[dict] = []
    for at, q, a in _memory:
        if now - at <= MEMORY_S:
            messages += [{"role": "user", "content": q}, {"role": "assistant", "content": a}]
    # Where the plane being asked about is on its route, and the weather along it.
    plane = flightinfo.subject(ctx)
    prog = flightinfo.progress(plane) if plane else None
    wx, took = await asyncio.gather(flightinfo.weather(plane, prog), _takeoff(plane, prog)) if plane else ({}, None)
    # "Is it windy in Detroit?": the weather at an airport named in the question, however it was put.
    spot = forecast.mentioned(rules.normalize(question), ctx)
    flight = "\n".join(flightinfo.context_lines(plane, prog, wx, took) + await forecast.context_lines(ctx, spot=spot))
    messages.append({"role": "user", "content": f"{context_text(ctx)}\n{flight}\n\nThe user said: {question}"})
    result = await llm.complete(messages, system=SYSTEM, schema=REPLY_SCHEMA)
    structured = result.get("structured") or {}
    reply = {"answer": (structured.get("answer") or "").strip(), "actions": validate_actions(structured.get("actions"))}
    if not reply["answer"] and not reply["actions"]:
        # Nothing to say and nothing to do would be silence in the headset: treat it as a failure.
        raise llm.LLMError("Aivana returned no answer and no valid action", code="empty")
    return reply


@app.post("/api/voice/ask")
async def ask(req: AskRequest) -> dict:
    timings: dict[str, int] = {}
    started = time.time()
    try:
        transcript = (req.text or "").strip() or await _transcribe(req)
    except Exception as e:  # noqa: BLE001
        return {"transcript": "", "answer": "I couldn't process the audio.", "actions": [], "source": "error", "error": str(e)[:200], "timings": timings}
    timings["whisperMs"] = round((time.time() - started) * 1000)
    if not transcript:
        return {"transcript": "", "answer": "I didn't catch that.", "actions": [], "source": "rules", "timings": timings}

    # What only the server knows about the radio: which feeds are live, and what was just said on
    # the one being listened to (or on any of them, if none is).
    radio_ctx = req.context.get("radio") if isinstance(req.context.get("radio"), dict) else {}
    connected = radio_ctx.get("connected") if isinstance(radio_ctx.get("connected"), str) else None
    req.context["feeds"] = [{"id": f.id, "name": f.cfg.get("name", f.id), "status": f.current_status(), "lastCallAt": f.last_call_at} for f in feeds.all_feeds() if f.configured]
    req.context["radioRecent"] = feeds.recent(connected)

    reply = rules.quick(transcript, req.context)
    source = "rules"
    error = None
    # Arrival time, distance and weather questions about the plane you're looking at: answered here
    # from its position, its route and current weather reports. (Weather is a quick lookup, cached.)
    # "How busy was Detroit overnight?": from the written record of calls (radiolog.py).
    logged = None if reply else radiotalk.log_question(rules.normalize(transcript), req.context, datetime.now().hour + datetime.now().minute / 60)
    if logged:
        records = await asyncio.to_thread(radiolog.read, time.time() - logged["hours"] * 3600)
        names = {s.get("id"): s.get("name") for s in (radio_ctx.get("stations") or []) if isinstance(s, dict)}
        if not radiolog.enabled and not records:
            reply = {"answer": "I'm not keeping a record of radio calls. Set RADIO_LOG to on in the server's settings to start one.", "actions": []}
        else:
            reply = {"answer": radiolog.spoken(radiolog.summary(records, _feed_names()), logged["hours"], names, logged["facility"]), "actions": []}
    # Weather here and the forecast ("will it rain this afternoon?", "what's the weather when it lands?"):
    # official airport reports and forecasts, looked up directly (cached).
    asked = None if reply else forecast.wants(rules.normalize(transcript))
    if asked:
        plane = flightinfo.subject(req.context)
        reply = {"answer": await forecast.answer(asked[0], asked[1], req.context, plane, flightinfo.progress(plane) if plane else None), "actions": []}
    kind = None if reply else flightinfo.wants(rules.normalize(transcript))
    if kind:
        plane = flightinfo.subject(req.context)
        prog = flightinfo.progress(plane) if plane else None
        wx = await flightinfo.weather(plane, prog) if plane and kind.startswith("weather") else {}
        # When it really took off (OpenSky's track): for "when did it take off?", and for a plane
        # with no route, where at least knowing where it came from is something.
        took = await _takeoff(plane, prog) if plane and (kind == "departed" or (kind in ("route", "origin") and not prog)) else None
        reply = {"answer": flightinfo.answer(kind, plane, prog, wx, took), "actions": []}
    # The same weather questions about a named airport ("the weather at Detroit Metro", "will it rain in Toledo tonight").
    placed = None if reply or kind else forecast.wants_at(rules.normalize(transcript), req.context)
    if placed:
        reply = {"answer": await forecast.answer(placed[0], placed[1], req.context, spot=placed[2]), "actions": []}
    if reply is None:
        llm_started = time.time()
        try:
            reply = await _ask_aivana(transcript, req.context)
            source = "aivana"
        except llm.LLMError as e:
            # Say why (no credit is not "can't reach"), then still something useful: the plane in view.
            focus = req.context.get("focus")
            why = aivana_trouble(e.code, e.status)
            reply = {"answer": f"{why} Here's what I can see: {describe(focus)}" if isinstance(focus, dict) and focus else why, "actions": []}
            source, error = "offline", f"{e.code or e.status}: {e}"[:200]
        timings["llmMs"] = round((time.time() - llm_started) * 1000)
    if source == "aivana" and reply["answer"]:
        _memory.append((time.time(), transcript, reply["answer"]))
    # Spoken here to save the phone a second request. If the phone words the reply itself (list counts),
    # it asks /api/voice/speak for that text instead.
    tts_started = time.time()
    speech = await _speech(reply["answer"])
    if speech:
        timings["ttsMs"] = round((time.time() - tts_started) * 1000)
    timings["totalMs"] = round((time.time() - started) * 1000)
    out = {"transcript": transcript, "answer": reply["answer"], "actions": reply["actions"], "source": source, "timings": timings, "speech": speech}
    if error:
        out["error"] = error
    return out
