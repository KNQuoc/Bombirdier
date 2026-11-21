"""The radio endpoints: which feeds exist and how they are doing, and the calls heard on them.

    GET  /api/feeds                      every feed with its status
    POST /api/feeds/{id}/check           is the stream there? (a quick look, without starting to listen)
    POST /api/radio/context              the callsigns the phone can see (helps Whisper spell them)
    GET  /api/radio/events?feed=&since=  calls heard since event `since`. Asking is what keeps a feed
                                         running: it starts on the first request and stops two minutes
                                         after the last one.
    GET  /api/radio/heard?callsign=      the latest call that named a plane

The phone polls /events a couple of times a second (Capacitor's native HTTP has no streaming).
"""
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import feeds

router = APIRouter()


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
