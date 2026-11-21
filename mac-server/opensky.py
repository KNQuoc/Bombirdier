"""When and where a plane actually took off, from the OpenSky Network's track of its current flight.

OpenSky (opensky-network.org) is a free, community-run receiver network. Its track endpoint returns
the path of an aircraft's current flight from the first point its receivers saw:

    GET https://opensky-network.org/api/tracks/all?icao24=<hex>&time=0
    -> { callsign, startTime, endTime, path: [[time, lat, lon, baro_altitude_m, true_track, on_ground], ...] }

If that first point is on or near the ground, it is the takeoff: a real time and a real place, which
nothing else Bombirdier has can give (adsb.lol has positions only; see flightinfo.py). If the plane
was first seen already high up (it flew into coverage), the track only says since when it has been
followed, and that is all that is claimed.

Being a polite guest: asked only when a question needs it, one plane at a time, answers kept for a
quarter of an hour, a clear User-Agent, and no asking at all for a while after being told to slow
down. No account or key is used (anonymous use has a daily allowance). OpenSky calls this endpoint
experimental: when it doesn't answer, the estimate from distance and speed is used as before.
"""
import asyncio
import re
import time
from datetime import datetime

import config
from flightinfo import distance_nm

TRACK_URL = "https://opensky-network.org/api/tracks/all"
TIMEOUT_S = 3.0
CACHE_S = 900  # a flight's start doesn't change; a new flight by the same plane is picked up after this
MISS_CACHE_S = 300  # no track for it: don't ask again for a while
# A first point this low is a departure even without the on-ground flag: most airports are below it.
LOW_START_M = 900
# Higher airports (Denver is 1,650 m): a start below this counts if the plane then climbed well above it.
HIGH_AIRPORT_M = 2500
CLIMBED_M = 1000
# The first point is "at" the route's origin airport within this distance.
AT_AIRPORT_NM = 15

_cache: dict[str, tuple[float, dict | None]] = {}
_blocked_until = 0.0
_client = None
remaining: str | None = None  # OpenSky's own count of requests left today, as last reported


def _hex(plane: dict) -> str | None:
    ident = str(plane.get("id") or "").lower()
    return ident if re.fullmatch(r"[0-9a-f]{6}", ident) else None  # "~..." ids are not real addresses


async def track(plane: dict) -> dict | None:
    """The plane's current track as OpenSky has it, or None. Never raises, never waits long."""
    global _client, _blocked_until, remaining
    ident = _hex(plane)
    now = time.time()
    if not ident:
        return None
    if ident in _cache and now - _cache[ident][0] <= (CACHE_S if _cache[ident][1] else MISS_CACHE_S):
        return _cache[ident][1]
    if now < _blocked_until:
        return None
    import httpx  # here, not at the top: the tests run without the server's packages

    if _client is None:
        _client = httpx.AsyncClient(timeout=TIMEOUT_S, headers={"User-Agent": config.USER_AGENT})
    try:
        r = await asyncio.wait_for(_client.get(f"{TRACK_URL}?icao24={ident}&time=0"), TIMEOUT_S)
    except Exception:  # noqa: BLE001 - slow or unreachable: the caller has an estimate to fall back on
        return None
    remaining = r.headers.get("x-rate-limit-remaining", remaining)
    if r.status_code == 429:
        wait = r.headers.get("x-rate-limit-retry-after-seconds", "")
        _blocked_until = now + (int(wait) if wait.isdigit() else 3600)
        return None
    data = None
    if r.status_code == 200:
        try:
            data = r.json()
        except ValueError:
            data = None
    if not isinstance(data, dict) or not isinstance(data.get("path"), list) or not data["path"]:
        data = None
    _cache[ident] = (now, data)
    return data


def takeoff(tr: dict | None, prog: dict | None = None, now: datetime | None = None) -> dict | None:
    """What a track says about the start of the flight:

        {at, agoMin, lat, lon, fromGround, atOrigin, awayFromOriginNm}

    `fromGround` False = the plane was first seen in the air: `at` is only when tracking began.
    `atOrigin` True = that first point is at the airport the route says it left from.
    """
    path = [p for p in (tr or {}).get("path") or [] if isinstance(p, list) and len(p) >= 6 and p[1] is not None and p[2] is not None]
    if not path:
        return None
    first = path[0]
    at = datetime.fromtimestamp(first[0])
    now = now or datetime.now()
    first_alt = first[3]
    highest = max((p[3] for p in path if p[3] is not None), default=None)
    climbed = first_alt is not None and highest is not None and highest - first_alt >= CLIMBED_M
    from_ground = bool(first[5]) or (first_alt is not None and (first_alt <= LOW_START_M or (first_alt <= HIGH_AIRPORT_M and climbed)))
    out = {
        "at": at,
        "agoMin": max(0.0, (now.timestamp() - first[0]) / 60),
        "lat": first[1],
        "lon": first[2],
        "fromGround": from_ground,
        "atOrigin": False,
        "awayFromOriginNm": None,
    }
    origin = (prog or {}).get("origin") or {}
    if origin.get("lat") is not None and origin.get("lon") is not None:
        out["awayFromOriginNm"] = distance_nm(origin["lat"], origin["lon"], first[1], first[2])
        out["atOrigin"] = out["awayFromOriginNm"] <= AT_AIRPORT_NM
    return out
