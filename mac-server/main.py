"""Bombirdier's Mac server: the phone sends a spoken question, this answers it.

    phone --audio + context--> POST /api/voice/ask
        1. mlx-whisper turns the audio into text (on this Mac)
        2. rules.py answers commands with one obvious meaning straight away
        3. otherwise Aivana answers, and may return actions for the phone to carry out
    phone <-- { transcript, answer, actions }

Run:  ./run.sh      (http://127.0.0.1:8787; the phone reaches it over USB with `adb reverse tcp:8787 tcp:8787`)
"""
import asyncio
import base64
import os
import tempfile
import threading
import time
from collections import deque

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import llm
import rules
import transcribe
from prompt import SYSTEM, context_text
from speech import describe
from tools import REPLY_SCHEMA, validate_actions

app = FastAPI(title="Bombirdier Mac server")
# The phone's requests are native (no CORS). This is for the desktop dev page.
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


class AskRequest(BaseModel):
    audio: str | None = None  # base64
    mime: str | None = None
    text: str | None = None  # a typed question instead of audio (desktop testing)
    context: dict = {}


@app.on_event("startup")
async def _startup() -> None:
    threading.Thread(target=transcribe.warm_up, daemon=True).start()


@app.get("/api/health")
async def health() -> dict:
    return {"ok": True, "whisper": transcribe.state(), "aivana": llm.available()}


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
        return await asyncio.to_thread(transcribe.transcribe, path, _callsigns(req.context))
    finally:
        os.unlink(path)  # recordings are never kept


async def _ask_aivana(question: str, ctx: dict) -> dict:
    now = time.time()
    messages: list[dict] = []
    for at, q, a in _memory:
        if now - at <= MEMORY_S:
            messages += [{"role": "user", "content": q}, {"role": "assistant", "content": a}]
    messages.append({"role": "user", "content": f"{context_text(ctx)}\n\nThe user said: {question}"})
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
    timings["totalMs"] = round((time.time() - started) * 1000)
    out = {"transcript": transcript, "answer": reply["answer"], "actions": reply["actions"], "source": source, "timings": timings}
    if error:
        out["error"] = error
    return out
