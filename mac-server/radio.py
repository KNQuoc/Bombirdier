"""The radio endpoints: which feeds exist and how they are doing, and the calls heard on them.

    GET  /api/feeds                      every feed with its status
    POST /api/feeds/{id}/check           is the stream there? (a quick look, without starting to listen)
    GET  /capture                        the page that captures a Chrome tab's sound for a "tab" feed
    POST /api/feeds/{id}/audio           that page pushing audio in
    POST /api/radio/context              the callsigns the phone can see (helps Whisper spell them)
    GET  /api/radio/events?feed=&since=  calls heard since event `since`. Asking is what keeps a feed
                                         running: it starts on the first request and stops two minutes
                                         after the last one.
    GET  /api/radio/heard?callsign=      the latest call that named a plane
    POST /api/feeds/{id}/listen          a short-lived ticket for the next line
    GET  /api/feeds/{id}/audio?ticket=   the feed's audio, live, as MP3: what the phone plays when you
                                         say "Can I access?" (an audio player can't send the token
                                         header, hence the ticket)

The phone polls /events a couple of times a second (Capacitor's native HTTP has no streaming).
"""
import secrets
import time
from urllib.parse import urlparse

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel

import config
import feeds

router = APIRouter()

# One push from the capture page is a quarter of a second of audio (8 kB); this is a guard, not a target.
MAX_PUSH_BYTES = 512 * 1024


@router.get("/capture")
async def capture_page():
    """The page that sends a Chrome tab's sound here (see feeds.py, kind "tab")."""
    return FileResponse(config.HERE / "capture.html", media_type="text/html")


@router.post("/api/feeds/{feed_id}/audio")
async def push_audio(feed_id: str, request: Request):
    """Raw audio from the capture page: 16 kHz, mono, 16-bit little-endian."""
    # Only the capture page sends this. Another website open in the same browser could otherwise
    # post made-up "radio" here: a browser always says where a cross-site request comes from.
    origin = request.headers.get("origin")
    if origin and urlparse(origin).hostname not in ("localhost", "127.0.0.1", "::1"):
        return JSONResponse({"error": "audio is only accepted from the capture page"}, status_code=403)
    feed = feeds.get(feed_id)
    if not feed or not feed.is_tab:
        return JSONResponse({"error": "no such tab feed"}, status_code=404)
    pcm = await request.body()
    if not pcm or len(pcm) > MAX_PUSH_BYTES or len(pcm) % 2:
        return JSONResponse({"error": "expected 16-bit audio, at most half a megabyte at a time"}, status_code=400)
    feed.push(pcm)
    return {"ok": True}


# Tickets for the live audio stream: asked for with the usual credentials, good for one start.
TICKET_TTL_S = 60
_tickets: dict[str, tuple[str, float]] = {}


def redeem_ticket(feed_id: str, ticket: str) -> bool:
    """True once for a ticket issued for this feed in the last minute."""
    now = time.time()
    for key in [k for k, (_, until) in _tickets.items() if until < now]:
        del _tickets[key]
    issued = _tickets.pop(ticket, None) if ticket else None
    return bool(issued) and issued[0] == feed_id


@router.post("/api/feeds/{feed_id}/listen")
async def listen_ticket(feed_id: str):
    feed = feeds.get(feed_id)
    if not feed or not feed.configured:
        return JSONResponse({"error": "no such feed"}, status_code=404)
    ticket = secrets.token_urlsafe(24)
    _tickets[ticket] = (feed_id, time.time() + TICKET_TTL_S)
    return {"ticket": ticket, "status": feed.current_status()}


@router.get("/api/feeds/{feed_id}/audio")
async def listen_audio(feed_id: str):
    """The live audio. Who may ask is decided in main.py's guard (this Mac, or a valid ticket)."""
    feed = feeds.get(feed_id)
    if not feed or not feed.configured:
        return JSONResponse({"error": "no such feed"}, status_code=404)
    return StreamingResponse(feed.listen(), media_type="audio/mpeg", headers={"Cache-Control": "no-store"})


class RadioContext(BaseModel):
    callsigns: list[str] = []


@router.get("/api/feeds")
async def list_feeds() -> dict:
    return {"feeds": [f.describe() for f in feeds.all_feeds()]}


@router.post("/api/feeds/{feed_id}/check")
async def check_feed(feed_id: str):
    feed = feeds.get(feed_id)
    if not feed:
        return JSONResponse({"error": "no such feed"}, status_code=404)
    status = await feed.check()
    return {**feed.describe(), "status": status}


@router.post("/api/radio/context")
async def radio_context(ctx: RadioContext) -> dict:
    feeds.set_around(ctx.callsigns)
    return {"ok": True}


@router.get("/api/radio/events")
async def radio_events(feed: str = "", since: int = 0):
    wanted = [feeds.get(feed)] if feed else [f for f in feeds.all_feeds() if f.configured]
    if feed and not wanted[0]:
        return JSONResponse({"error": "no such feed"}, status_code=404)
    events = []
    for f in wanted:
        f.use()  # asking for a feed's calls is what keeps it listening
        events += [e for e in f.events if e["id"] > since]
    events.sort(key=lambda e: e["id"])
    return {"events": events, "feeds": [f.describe() for f in wanted]}


@router.get("/api/radio/heard")
async def radio_heard(callsign: str = "") -> dict:
    return {"heard": feeds.heard(callsign) if callsign.strip() else None}
