"""Where a flight is on its route, when it should arrive, and what the weather is doing along it.

Everything about times here is an ESTIMATE worked out from the plane's position and speed and the
two airports of its route. There is no free source of airline schedules or actual departure times:
adsb.lol has none, its flight-history pages are not open to programs, and a web search through Aivana
found nothing live (tried 2026-11-21). A flight-status API with a key would be needed for real times.

Weather is real: current reports (METARs) from the US government's aviationweather.gov, for the
origin, the destination and the station nearest the plane.
"""
import asyncio
import math
import re
import time
from datetime import datetime, timedelta

import config
from speech import compass_word, spoken_name

EARTH_RADIUS_NM = 3440.065
# Extra minutes on top of distance / speed for slowing down and flying the approach.
APPROACH_MIN = 6
# A flight's average speed since takeoff is below what it does in cruise (climb, turns).
AVERAGE_SPEED_FACTOR = 0.9
# ...but a plane slowing down to land is far below its average. The estimate of when it left never
# assumes an average slower than this (knots), by kind of aircraft.
TYPICAL_AVERAGE_KT = {"jet": 380, "prop": 110, None: 200}
# Taxi-out and takeoff are not part of "distance flown / speed".
DEPARTURE_PAD_MIN = 8
# Below this the plane is taxiing, hovering or the speed is junk: no arrival estimate.
MIN_SPEED_KT = 60

METAR_URL = "https://aviationweather.gov/api/data/metar"
METAR_TTL_S = 600
WEATHER_TIMEOUT_S = 3.0
# How far around the plane to look for a reporting station (degrees of latitude / longitude).
NEAR_BOX_DEG = 0.7
_metar_cache: dict[str, tuple[float, dict | None]] = {}
_client = None  # one connection kept open: the first request to the weather service is the slow one


def distance_nm(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * EARTH_RADIUS_NM * math.asin(math.sqrt(a))


def subject(ctx: dict) -> dict | None:
    """The plane a question is about: the one in the middle of the view, else one opened from the list."""
    return ctx.get("focus") or ctx.get("opened")


def progress(plane: dict, now: datetime | None = None) -> dict | None:
    """Distances along the route and time estimates, or None if the plane has no route or position."""
    route = plane.get("route") or {}
    origin, destination = route.get("origin"), route.get("destination")
    if not origin or not destination or plane.get("lat") is None or plane.get("lon") is None:
        return None
    flown = distance_nm(origin["lat"], origin["lon"], plane["lat"], plane["lon"])
    remaining = distance_nm(plane["lat"], plane["lon"], destination["lat"], destination["lon"])
    total = distance_nm(origin["lat"], origin["lon"], destination["lat"], destination["lon"])
    out = {
        "origin": origin,
        "destination": destination,
        "flownNm": flown,
        "remainingNm": remaining,
        "totalNm": total,
        "fraction": flown / (flown + remaining) if flown + remaining > 0 else 0.0,
        "etaMin": None,
        "eta": None,
        "sinceDepartureMin": None,
        "onGround": bool(plane.get("onGround")),
    }
    speed = plane.get("groundSpeedKt")
    if not out["onGround"] and speed and speed >= MIN_SPEED_KT:
        out["etaMin"] = remaining / speed * 60 + (APPROACH_MIN if remaining > 30 else 0)
        out["eta"] = (now or datetime.now().astimezone()) + timedelta(minutes=out["etaMin"])
        average = max(speed * AVERAGE_SPEED_FACTOR, TYPICAL_AVERAGE_KT.get(plane.get("engine"), TYPICAL_AVERAGE_KT[None]))
        out["sinceDepartureMin"] = flown / average * 60 + DEPARTURE_PAD_MIN
    return out


def spoken_duration(minutes: float) -> str:
    m = max(1, round(minutes))
    if m < 60:
        return f"{m} minute{'s' if m != 1 else ''}"
    # Past an hour nobody wants "3 hours 47 minutes" from an estimate: round to five.
    m = round(m / 5) * 5
    hours, rest = divmod(m, 60)
    h = f"{hours} hour{'s' if hours != 1 else ''}"
    return h if rest == 0 else f"{h} {rest} minutes"


def spoken_clock(t: datetime) -> str:
    return t.strftime("%I:%M %p").lstrip("0")


def place(airport: dict) -> str:
    """How to say an airport: its city if we know it, else its name or code."""
    return airport.get("city") or airport.get("name") or " ".join(airport.get("code") or "")


def miles(nm: float) -> str:
    n = round(nm) if nm < 100 else round(nm / 10) * 10
    return f"{n:,} mile{'s' if n != 1 else ''}"


# ---- weather -------------------------------------------------------------------------------------

COVER = {"SKC": "clear", "CLR": "clear", "CAVOK": "clear", "FEW": "a few clouds", "SCT": "scattered clouds", "BKN": "broken clouds", "OVC": "overcast", "OVX": "sky obscured"}
CATEGORY = {"VFR": "good flying weather", "MVFR": "marginal", "IFR": "instrument conditions", "LIFR": "low instrument conditions"}
WEATHER_CODES = {"RA": "rain", "SN": "snow", "DZ": "drizzle", "FG": "fog", "BR": "mist", "HZ": "haze", "TS": "thunderstorms", "TSRA": "thunderstorms and rain", "SH": "showers", "SHRA": "rain showers", "SHSN": "snow showers", "FZRA": "freezing rain", "FZFG": "freezing fog", "GR": "hail", "FU": "smoke", "PL": "ice pellets", "UP": "precipitation"}


def describe_metar(m: dict) -> str:
    """A current weather report in a sentence: wind, visibility, sky, weather, temperature, category."""
    parts = []
    wdir, wspd, gust = m.get("wdir"), m.get("wspd"), m.get("wgst")
    if not wspd:
        parts.append("wind calm")
    else:
        direction = "variable" if not isinstance(wdir, (int, float)) else f"from the {compass_word(wdir)}"
        parts.append(f"wind {direction} at {round(wspd)} knots" + (f", gusting {round(gust)}" if gust else ""))
    vis = m.get("visib")
    if vis is not None:
        text = str(vis).rstrip("+")
        parts.append(f"visibility {'more than ' if str(vis).endswith('+') else ''}{text} miles")
    wx = m.get("wxString")
    if wx:
        words = []
        for token in str(wx).split():
            intensity = "heavy " if token.startswith("+") else "light " if token.startswith("-") else ""
            code = token.lstrip("+-").replace("VC", "")
            words.append(intensity + WEATHER_CODES.get(code, code))
        parts.append(", ".join(words))
    clouds = [c for c in m.get("clouds") or [] if c.get("cover")]
    if not clouds or clouds[0].get("cover") in ("SKC", "CLR", "CAVOK"):
        parts.append("clear skies")
    else:
        # The lowest broken or overcast layer is the ceiling; otherwise the lowest layer says enough.
        layer = next((c for c in clouds if c["cover"] in ("BKN", "OVC", "OVX")), clouds[0])
        base = layer.get("base")
        parts.append(COVER.get(layer["cover"], layer["cover"]) + (f" at {round(base):,} feet" if base else ""))
    if m.get("temp") is not None:
        parts.append(f"{round(m['temp'])} degrees Celsius")
    text = ", ".join(parts)
    category = CATEGORY.get(m.get("fltCat") or "")
    return f"{text}. {category.capitalize()}." if category else f"{text}."


async def _get(query: str) -> list[dict]:
    """`query` goes in the URL as written: the service wants its commas plain, not percent-encoded."""
    global _client
    import httpx  # here, not at the top: the tests run without the server's packages

    if _client is None:
        _client = httpx.AsyncClient(timeout=WEATHER_TIMEOUT_S, headers={"User-Agent": config.USER_AGENT})
    r = await _client.get(f"{METAR_URL}?{query}&format=json")
    if r.status_code != 200 or not r.text.strip():
        return []
    data = r.json()
    return data if isinstance(data, list) else []


async def weather(plane: dict, prog: dict | None) -> dict:
    """{"origin": metar, "destination": metar, "below": metar} for whatever could be found in time.

    Reports are cached for ten minutes. Never raises and never takes longer than WEATHER_TIMEOUT_S:
    a spoken answer shouldn't wait on a weather server.
    """
    now = time.time()
    wanted = {}
    if prog:
        for end in ("origin", "destination"):
            icao = (prog[end].get("icao") or "").upper()
            if re.fullmatch(r"[A-Z0-9]{4}", icao):
                wanted[end] = icao
    out: dict = {}
    missing = [icao for icao in set(wanted.values()) if icao not in _metar_cache or now - _metar_cache[icao][0] > METAR_TTL_S]
    lat, lon = plane.get("lat"), plane.get("lon")
    near_key = f"near:{round(lat, 1)},{round(lon, 1)}" if lat is not None and lon is not None and not plane.get("onGround") else None
    need_near = near_key and (near_key not in _metar_cache or now - _metar_cache[near_key][0] > METAR_TTL_S)

    async def fetch_stations():
        for m in await _get("ids=" + ",".join(missing)):
            _metar_cache[m.get("icaoId", "")] = (now, m)
        for icao in missing:
            _metar_cache.setdefault(icao, (now, None))  # asked and not there: don't ask again for a while

    async def fetch_near():
        # Box corners as south,west,north,east.
        box = f"{lat - NEAR_BOX_DEG:.2f},{lon - NEAR_BOX_DEG:.2f},{lat + NEAR_BOX_DEG:.2f},{lon + NEAR_BOX_DEG:.2f}"
        reports = [m for m in await _get("bbox=" + box) if m.get("lat") is not None and m.get("lon") is not None]
        nearest = min(reports, key=lambda m: distance_nm(lat, lon, m["lat"], m["lon"]), default=None)
        if nearest:
            nearest = {**nearest, "distanceNm": distance_nm(lat, lon, nearest["lat"], nearest["lon"])}
        _metar_cache[near_key] = (now, nearest)

    jobs = ([fetch_stations()] if missing else []) + ([fetch_near()] if need_near else [])
    if jobs:
        try:
            # Each lookup stands alone: one failing or timing out doesn't lose the other.
            await asyncio.wait_for(asyncio.gather(*jobs, return_exceptions=True), WEATHER_TIMEOUT_S)
        except Exception:  # noqa: BLE001 - weather is a nice-to-have; say what we have
            pass
    for end, icao in wanted.items():
        if _metar_cache.get(icao, (0, None))[1]:
            out[end] = _metar_cache[icao][1]
    if near_key and _metar_cache.get(near_key, (0, None))[1]:
        out["below"] = _metar_cache[near_key][1]
    return out


def station_name(m: dict) -> str:
    """"Findlay" from "Findlay Arpt, OH, US"."""
    name = (m.get("name") or m.get("icaoId") or "").split(",")[0]
    return re.sub(r"\s*(/.*|\b(Intl|Arpt|Airport|Rgnl|Muni|Field|Fld|Co|County)\b\.?)\s*$", "", name, flags=re.I).strip() or name


# ---- answers ---------------------------------------------------------------------------------------

_IT = r"(?:it|that|this|he|she|they|(?:that|this|the) (?:plane|flight|one|aircraft|jet))"
_ETA = [
    rf"(?:when|what time) (?:does|will|is|s|would) {_IT} (?:going to |gonna |supposed to |scheduled to |expected to |due to )?(?:land|landing|arrive|arriving|get there|get in|be there|touch down|reach)\b.*",
    r"how (?:long|much longer|much time)(?: is it| will it be| will it take| does it have| has it got| do they have)? (?:until|till|before|to go|left|to get)\b.*",
    r"(?:whats|what is) (?:its|the|their|that planes|that flights) (?:eta|estimated time of arrival|arrival time|estimated arrival|time of arrival)\b.*",
    r"(?:eta|arrival time|time of arrival)",
]
_DISTANCE = [
    rf"how far (?:has|did|have) {_IT} (?:flown|come|gone|traveled|travelled|fly|been)\b.*",
    rf"how far (?:does {_IT} have|has {_IT} got|is {_IT}|is left|left|to go)(?: to go| left| from .*| to .*)?",
    r"how (?:many miles|far|much further|much farther)(?: are)? (?:left|to go|remaining)\b.*",
]
_DEPARTED = [
    rf"(?:when|what time) did {_IT} (?:take off|depart|leave|departed|left)\b.*",
    rf"how long (?:has {_IT} been|its been|is it been) (?:flying|in the air|airborne|up)\b.*",
]
_ROUTE = [
    rf"where(?: is| s|s) {_IT} (?:going|headed|heading|flying to|landing|off to|bound)\b.*",
    rf"where (?:did|is|s) {_IT} (?:come|coming|flying|fly|depart|departing|take off) from\b.*",
    rf"where(?: is| s|s) {_IT} from",
    rf"(?:whats|what is) (?:its|the|their) (?:route|destination|origin)",
]
_WEATHER_DEST = r"(?:whats|what is|hows|how is|what about) the weather (?:like )?(?:at|in) (?:its|the|their) destination|(?:whats|what is|hows|how is) the weather (?:like )?(?:where (?:its|it is|theyre|they are) (?:going|landing|headed|heading)|there)|(?:whats|what is|hows|how is) the weather (?:like )?(?:going to be )?when (?:it|they) (?:lands?|arrives?|gets? there)"
_WEATHER_BELOW = r"(?:whats|what is|hows|how is) the weather (?:like )?(?:where (?:it|that plane) is|below (?:it|that plane)|under (?:it|that plane)|around (?:it|that plane)|along (?:the|its) (?:way|route)|en ?route|up there)(?: right now| now)?"
_WEATHER_ORIGIN = r"(?:whats|what is|hows|how is|what was|how was) the weather (?:like )?(?:where (?:it|they) (?:came|come|took off|departed|left) from|at (?:its|the|their) origin|at (?:its|the|their) departure(?: airport)?)"


def _matches(text: str, patterns) -> bool:
    return any(re.fullmatch(p, text) for p in ([patterns] if isinstance(patterns, str) else patterns))


def wants(text: str) -> str | None:
    """Which flight question a normalized transcript is, if it is plainly one of them."""
    if _matches(text, _WEATHER_DEST):
        return "weather_destination"
    if _matches(text, _WEATHER_BELOW):
        return "weather_below"
    if _matches(text, _WEATHER_ORIGIN):
        return "weather_origin"
    if _matches(text, _ETA):
        return "eta"
    if _matches(text, _DISTANCE):
        return "distance"
    if _matches(text, _DEPARTED):
        return "departed"
    if _matches(text, _ROUTE):
        return "route"
    return None


def answer(kind: str, plane: dict | None, prog: dict | None, wx: dict) -> str:
    """The spoken answer to one of the flight questions."""
    if not plane:
        return "I don't see a plane in the middle of your view. Point at one, or open one from the list."
    name = spoken_name(plane)
    if not prog:
        return f"I don't know where {name} is going: there's no route on file for it, so I can't work that out."
    origin, destination = place(prog["origin"]), place(prog["destination"])
    if kind == "route":
        return f"{name} is flying from {origin} to {destination}, {miles(prog['remainingNm'])} to go."
    if kind == "distance":
        return f"It has flown about {miles(prog['flownNm'])} from {origin} and has {miles(prog['remainingNm'])} to go to {destination}."
    if kind == "eta":
        if prog["onGround"]:
            return f"It's on the ground, with {miles(prog['remainingNm'])} to {destination}."
        if prog["etaMin"] is None:
            return f"It's {miles(prog['remainingNm'])} from {destination}, but I can't estimate a time without a usable speed."
        return (
            f"About {spoken_duration(prog['etaMin'])}, around {spoken_clock(prog['eta'])} your time. "
            f"That's my estimate from {miles(prog['remainingNm'])} to {destination} at {round(plane['groundSpeedKt'])} knots, not the airline's time."
        )
    if kind == "departed":
        if prog["sinceDepartureMin"] is None:
            return f"I don't have its departure time from {origin}."
        return f"Roughly {spoken_duration(prog['sinceDepartureMin'])} ago from {origin}, judging by the {miles(prog['flownNm'])} it has covered. I don't have the airline's actual departure time."
    if kind in ("weather_destination", "weather_origin"):
        end = "destination" if kind == "weather_destination" else "origin"
        report = wx.get(end)
        where = place(prog[end])
        return f"{where} right now: {describe_metar(report)}" if report else f"I couldn't get a weather report for {where} just now."
    if kind == "weather_below":
        report = wx.get("below")
        if not report:
            return "I couldn't find a weather station near it just now."
        return f"On the ground below it, near {station_name(report)}: {describe_metar(report)}"
    return ""


def context_lines(plane: dict | None, prog: dict | None, wx: dict) -> list[str]:
    """Flight progress and weather as lines for Aivana's context."""
    if not plane or not prog:
        return []
    origin, destination = prog["origin"], prog["destination"]
    lines = [
        f"Its flight (estimates from position and speed, not airline data): {miles(prog['flownNm'])} flown from {place(origin)} ({origin.get('code')}), "
        f"{miles(prog['remainingNm'])} to go to {place(destination)} ({destination.get('code')}), {round(prog['fraction'] * 100)}% of the way."
    ]
    if prog["etaMin"] is not None:
        lines.append(
            f"Estimated arrival in {spoken_duration(prog['etaMin'])}, about {spoken_clock(prog['eta'])} the user's local time. "
            f"Estimated to have left about {spoken_duration(prog['sinceDepartureMin'])} ago. Scheduled and actual airline times are not available: say these are estimates."
        )
    for key, label in (("origin", f"Weather now at {place(origin)}"), ("destination", f"Weather now at {place(destination)}")):
        if wx.get(key):
            lines.append(f"{label}: {describe_metar(wx[key])} (raw: {wx[key].get('rawOb', '')})")
    if wx.get("below"):
        lines.append(f"Weather on the ground below the plane ({station_name(wx['below'])}, {round(wx['below'].get('distanceNm', 0))} miles from it): {describe_metar(wx['below'])}")
    return lines
