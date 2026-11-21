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
import hmac
import ipaddress
import os
import tempfile
import time
from collections import deque

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import asyncio

import config
import feeds
import flightinfo
import gpu
import llm
import radio
import rules
import transcribe
import tts
from prompt import SYSTEM, context_text
from speech import describe
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
    protected = request.url.path.startswith("/api/") and request.url.path != "/api/health"
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


async def _ask_aivana(question: str, ctx: dict) -> dict:
    now = time.time()
    messages: list[dict] = []
    for at, q, a in _memory:
        if now - at <= MEMORY_S:
            messages += [{"role": "user", "content": q}, {"role": "assistant", "content": a}]
    # Where the plane being asked about is on its route, and the weather along it.
    plane = flightinfo.subject(ctx)
    prog = flightinfo.progress(plane) if plane else None
    wx = await flightinfo.weather(plane, prog) if plane else {}
    flight = "\n".join(flightinfo.context_lines(plane, prog, wx))
    messages.append({"role": "user", "content": f"{context_text(ctx)}\n{flight}\n\nThe user said: {question}"})
    result = await llm.complete(messages, system=SYSTEM, schema=REPLY_SCHEMA)
    structured = result.get("structured") or {}
    return {"answer": (structured.get("answer") or "").strip(), "actions": validate_actions(structured.get("actions"))}


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

    reply = rules.quick(transcript, req.context)
    source = "rules"
    error = None
    # Arrival time, distance and weather questions about the plane you're looking at: answered here
    # from its position, its route and current weather reports. (Weather is a quick lookup, cached.)
    kind = None if reply else flightinfo.wants(rules.normalize(transcript))
    if kind:
        plane = flightinfo.subject(req.context)
        prog = flightinfo.progress(plane) if plane else None
        wx = await flightinfo.weather(plane, prog) if plane and kind.startswith("weather") else {}
        reply = {"answer": flightinfo.answer(kind, plane, prog, wx), "actions": []}
    if reply is None:
        llm_started = time.time()
        try:
            reply = await _ask_aivana(transcript, req.context)
            source = "aivana"
        except llm.LLMError as e:
            # Still say something useful: describe the plane in view if there is one.
            focus = req.context.get("focus")
            reply = {"answer": describe(focus) if focus else "I can't reach Aivana right now.", "actions": []}
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
