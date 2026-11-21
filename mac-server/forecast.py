"""Weather where you are, and what it is forecast to do: answers the assistant gives without Aivana.

Both come from the US government's aviationweather.gov, the same free service flightinfo.py uses:

  METAR  what an airport's weather station reports right now (issued about hourly)
  TAF    the forecast for an airport for the next 24 to 30 hours, written by a forecaster as a list
         of periods: "from 1 PM: wind south at 8, clear", "at times between 3 and 6: rain showers"

Wood County (1G0) has neither, like most small fields, so the nearest station that does is used and
named in the answer. Nothing here says whether it is safe to fly: it reads out the forecast.

(Aivana's web search was tried for this on 2026-11-21 and returned a report six hours old; see
docs/aivana.md.)
"""
import asyncio
import re
import time
from datetime import datetime, timedelta

import airports
import flightinfo
from flightinfo import COVER, WEATHER_CODES, describe_metar, distance_nm, place, spoken_clock, station_name

TAF_TTL_S = 1800  # forecasts are reissued every six hours, amended in between
# How far around a point to look for a station (degrees). Forecast sites are sparser than weather stations.
METAR_BOX_DEG = 0.6
TAF_BOX_DEG = 1.1
# Used when the phone sends no position: Wood County Regional Airport.
HOME = (41.391, -83.6301)
# How far ahead "what's the forecast?" looks, and how many periods it reads out.
DEFAULT_HOURS = 12
MAX_PERIODS = 3

RAIN = ("RA", "DZ", "SH", "TS", "UP")
SNOW = ("SN", "SG", "PL", "IC", "GS")
STORM = ("TS",)
ANY_PRECIP = RAIN + SNOW + ("GR", "FZ")

_cache: dict[str, tuple[float, dict | None]] = {}


# ---- getting reports ---------------------------------------------------------------------------------


def where(ctx: dict) -> tuple[float, float]:
    """Where the user is, as well as the phone told us."""
    viewer = ctx.get("viewer") or {}
    if isinstance(viewer.get("lat"), (int, float)) and isinstance(viewer.get("lon"), (int, float)):
        return viewer["lat"], viewer["lon"]
    return HOME


async def nearest(kind: str, lat: float, lon: float) -> dict | None:
    """The nearest METAR ("metar") or TAF ("taf") to a point, with `distanceNm` added. Cached."""
    key = f"{kind}:{round(lat, 1)},{round(lon, 1)}"
    ttl = TAF_TTL_S if kind == "taf" else flightinfo.METAR_TTL_S
    if key in _cache and time.time() - _cache[key][0] <= ttl:
        return _cache[key][1]
    deg = TAF_BOX_DEG if kind == "taf" else METAR_BOX_DEG
    box = f"{lat - deg:.2f},{lon - deg * 1.3:.2f},{lat + deg:.2f},{lon + deg * 1.3:.2f}"  # south,west,north,east
    try:
        reports = await asyncio.wait_for(flightinfo._get("bbox=" + box, kind), flightinfo.WEATHER_TIMEOUT_S)
    except Exception:  # noqa: BLE001 - no weather is an answer too ("I couldn't get...")
        return _cache.get(key, (0, None))[1]
    reports = [r for r in reports if r.get("lat") is not None and r.get("lon") is not None]
    best = min(reports, key=lambda r: distance_nm(lat, lon, r["lat"], r["lon"]), default=None)
    if best:
        best = {**best, "distanceNm": distance_nm(lat, lon, best["lat"], best["lon"])}
    _cache[key] = (time.time(), best)
    return best


async def for_airport(icao: str) -> dict | None:
    """The TAF for one airport, or None if it has none."""
    icao = (icao or "").upper()
    if not re.fullmatch(r"[A-Z0-9]{4}", icao):
        return None
    key = f"taf:{icao}"
    if key in _cache and time.time() - _cache[key][0] <= TAF_TTL_S:
        return _cache[key][1]
    try:
        reports = await asyncio.wait_for(flightinfo._get("ids=" + icao, "taf"), flightinfo.WEATHER_TIMEOUT_S)
    except Exception:  # noqa: BLE001
        return None
    _cache[key] = (time.time(), reports[0] if reports else None)
    return _cache[key][1]


# ---- reading a forecast --------------------------------------------------------------------------------


def _visibility(f: dict) -> float | None:
    """Statute miles. "6+" (more than six) counts as 7."""
    v = f.get("visib")
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    m = re.search(r"\d+(?:\.\d+)?", str(v))
    return (float(m.group()) + (1 if "+" in str(v) else 0)) if m else None


def _ceiling(f: dict) -> float | None:
    """Height of the lowest broken or overcast layer in feet; None = no ceiling."""
    bases = [c.get("base") for c in f.get("clouds") or [] if c.get("cover") in ("BKN", "OVC", "OVX") and c.get("base") is not None]
    if f.get("vertVis") is not None:
        bases.append(f["vertVis"] * (100 if f["vertVis"] < 100 else 1))
    return min(bases) if bases else None


def category(f: dict) -> str:
    """VFR / MVFR / IFR / LIFR from ceiling and visibility, the way flight categories are defined."""
    ceiling, vis = _ceiling(f), _visibility(f)
    c = 99_999 if ceiling is None else ceiling
    v = 99 if vis is None else vis
    if c < 500 or v < 1:
        return "LIFR"
    if c < 1000 or v < 3:
        return "IFR"
    if c <= 3000 or v <= 5:
        return "MVFR"
    return "VFR"


CATEGORY_WORDS = {"VFR": "visual conditions", "MVFR": "marginal visual conditions", "IFR": "instrument conditions", "LIFR": "low instrument conditions"}


def _weather_words(wx: str | None) -> str:
    words = []
    for token in str(wx or "").split():
        intensity = "heavy " if token.startswith("+") else "light " if token.startswith("-") else ""
        code = token.lstrip("+-").replace("VC", "")
        words.append(intensity + WEATHER_CODES.get(code, code))
    return ", ".join(words)


def describe_period(f: dict) -> str:
    """One forecast period in a sentence: wind, visibility, weather, sky, and the category unless it's plain VFR."""
    text = describe_metar({k: v for k, v in f.items() if k not in ("temp", "fltCat")})
    cat = category(f)
    return text if cat == "VFR" else f"{text} {CATEGORY_WORDS[cat].capitalize()}."


def describe_partial(f: dict) -> str:
    """A "temporarily" or "chance of" period only names what differs: say just that."""
    parts = []
    if f.get("wxString"):
        parts.append(_weather_words(f["wxString"]))
    vis = _visibility(f)
    if vis is not None and vis <= 5:
        parts.append(f"visibility {str(f['visib']).rstrip('+')} miles")
    ceiling = _ceiling(f)
    if ceiling is not None and ceiling <= 3000:
        layer = next(c for c in f.get("clouds") or [{}] if c.get("base") == ceiling) if any(c.get("base") == ceiling for c in f.get("clouds") or []) else {}
        parts.append(f"{COVER.get(layer.get('cover'), 'ceiling')} at {round(ceiling):,} feet")
    if f.get("wgst"):
        parts.append(f"gusts to {round(f['wgst'])} knots")
    return ", ".join(parts)


def periods(taf: dict) -> tuple[list[dict], list[dict]]:
    """(prevailing, temporary). Prevailing periods are complete states in time order; a "becoming"
    period names only what changes, so it is laid over the state before it."""
    prevailing: list[dict] = []
    temporary: list[dict] = []
    for f in sorted(taf.get("fcsts") or [], key=lambda f: f.get("timeFrom") or 0):
        change = f.get("fcstChange")
        if change in ("TEMPO", "PROB"):
            temporary.append(f)
        elif change == "BECMG" and prevailing:
            merged = {**prevailing[-1], **{k: v for k, v in f.items() if v not in (None, [], "")}}
            # The change is complete by timeBec; before that the old state still mostly holds.
            merged["timeFrom"] = f.get("timeBec") or f.get("timeFrom")
            prevailing[-1] = {**prevailing[-1], "timeTo": merged["timeFrom"]}
            prevailing.append(merged)
        else:
            prevailing.append(dict(f))
    return prevailing, temporary


def hour(ts: float, now: datetime) -> str:
    """"1 PM", "noon", "tomorrow at 6 AM": a time in a forecast, local to this Mac (and so to the user)."""
    t = datetime.fromtimestamp(ts)
    if t.minute == 0:
        clock = "noon" if t.hour == 12 else "midnight" if t.hour == 0 else t.strftime("%I %p").lstrip("0")
    else:
        clock = spoken_clock(t)
    days = (t.date() - now.date()).days
    if clock == "midnight" and days == 1:
        return "midnight"
    return clock if days <= 0 else f"tomorrow at {clock}" if days == 1 else f"{t.strftime('%A')} at {clock}"


def _overlaps(f: dict, start: float, end: float) -> bool:
    return (f.get("timeFrom") or 0) < end and (f.get("timeTo") or 0) > start


def summary(taf: dict, now: datetime, hours: float = DEFAULT_HOURS) -> str:
    """The next `hours` of a forecast, read out period by period."""
    start, end = now.timestamp(), now.timestamp() + hours * 3600
    prevailing, temporary = periods(taf)
    current = [f for f in prevailing if _overlaps(f, start, end)][:MAX_PERIODS]
    if not current:
        return "The forecast I have doesn't cover that time."
    out = []
    for i, f in enumerate(current):
        if i == 0:
            lead = f"Until {hour(f['timeTo'], now)}" if len(current) > 1 else f"Through {hour(min(f['timeTo'], end), now)}"
        else:
            lead = f"From {hour(f['timeFrom'], now)}"
        out.append(f"{lead}: {describe_period(f)}")
    for f in [f for f in temporary if _overlaps(f, start, end)][:2]:
        what = describe_partial(f)
        if not what:
            continue
        span = f"between {hour(f['timeFrom'], now)} and {hour(f['timeTo'], now)}"
        chance = f.get("probability")
        out.append(f"A {round(chance)} percent chance of {what} {span}." if chance else f"At times {span}: {what}.")
    return " ".join(out)


def window(text: str, now: datetime) -> tuple[datetime, datetime, str]:
    """The time a question is about: (start, end, how to say it)."""
    day = now.replace(minute=0, second=0, microsecond=0)

    def at(h: int, days: int = 0) -> datetime:
        return day.replace(hour=h % 24) + timedelta(days=days + h // 24)

    spans = []
    if "tomorrow" in text:
        if "morning" in text:
            spans.append((at(6, 1), at(12, 1), "tomorrow morning"))
        elif "afternoon" in text:
            spans.append((at(12, 1), at(18, 1), "tomorrow afternoon"))
        elif "evening" in text or "night" in text:
            spans.append((at(18, 1), at(24, 1), "tomorrow evening"))
        else:
            spans.append((at(6, 1), at(22, 1), "tomorrow"))
    elif "tonight" in text:
        spans.append((max(now, at(18)), at(30), "tonight"))
    elif "this afternoon" in text:
        spans.append((max(now, at(12)), at(18), "this afternoon"))
    elif "this evening" in text:
        spans.append((max(now, at(17)), at(23), "this evening"))
    elif "this morning" in text:
        spans.append((now, at(12), "this morning"))
    m = re.search(r"next (\w+) hours?", text)
    if m:
        n = int(m.group(1)) if m.group(1).isdigit() else {"few": 3, "couple": 2, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "eight": 8, "twelve": 12}.get(m.group(1))
        if n:
            spans.append((now, now + timedelta(hours=n), f"in the next {n} hours"))
    for start, end, label in spans:
        if end > start:  # "this afternoon", asked in the evening, is over: fall through to the default
            return start, end, label
    return now, now + timedelta(hours=DEFAULT_HOURS), f"in the next {DEFAULT_HOURS} hours"


def precipitation(taf: dict, now: datetime, start: datetime, end: datetime, label: str, codes: tuple = ANY_PRECIP, noun: str = "rain or snow") -> str:
    """"Will it rain?": the first precipitation in the window, or that there is none."""
    name = station_name(taf)
    valid_to = taf.get("validTimeTo") or max((f.get("timeTo") or 0) for f in taf.get("fcsts") or [{}])
    s, e = start.timestamp(), min(end.timestamp(), valid_to)
    if e <= s:
        return f"The {name} forecast only runs until {hour(valid_to, now)}, so I can't say for {label}."
    prevailing, temporary = periods(taf)
    hits = [f for f in prevailing + temporary if _overlaps(f, s, e) and any(c in str(f.get("wxString") or "") for c in codes)]
    hits.sort(key=lambda f: f.get("timeFrom") or 0)
    cut_short = f" The forecast only runs until {hour(valid_to, now)}." if valid_to < end.timestamp() - 1800 else ""
    if not hits:
        return f"No {noun} in the {name} forecast {label}.{cut_short}"
    f = hits[0]
    what = _weather_words(f["wxString"])
    begins = max(f["timeFrom"], s)
    if f.get("probability"):
        return f"Maybe: a {round(f['probability'])} percent chance of {what} between {hour(f['timeFrom'], now)} and {hour(f['timeTo'], now)}, in the {name} forecast.{cut_short}"
    if f.get("fcstChange") == "TEMPO":
        return f"At times, yes: {what} between {hour(f['timeFrom'], now)} and {hour(f['timeTo'], now)}, in the {name} forecast.{cut_short}"
    when = "already in the forecast now" if begins <= now.timestamp() + 900 else f"from about {hour(begins, now)}"
    return f"Yes: {what} {when}, in the {name} forecast.{cut_short}"


def flying(taf: dict, now: datetime, start: datetime, end: datetime, label: str) -> str:
    """"Will it stay VFR?": the flight category through the window, and what changes it."""
    name = station_name(taf)
    s, e = start.timestamp(), end.timestamp()
    prevailing, temporary = periods(taf)
    seq = [f for f in prevailing if _overlaps(f, s, e)]
    if not seq:
        return f"The {name} forecast doesn't cover {label}."
    cats = [category(f) for f in seq]
    worst_temp = [f for f in temporary if _overlaps(f, s, e) and category(f) != "VFR"]
    tail = " Check the official briefing before you fly."
    if all(c == cats[0] for c in cats):
        text = f"The {name} forecast is {CATEGORY_WORDS[cats[0]]} {label}"
        if worst_temp:
            f = worst_temp[0]
            text += f", dropping at times between {hour(f['timeFrom'], now)} and {hour(f['timeTo'], now)}: {describe_partial(f)}"
        return text + "." + tail
    change = next(i for i, c in enumerate(cats) if c != cats[0])
    f = seq[change]
    reason = describe_partial(f) or describe_period(f).rstrip(".")
    return f"{CATEGORY_WORDS[cats[0]].capitalize()} until {hour(f['timeFrom'], now)}, then {CATEGORY_WORDS[cats[change]]}: {reason}, in the {name} forecast.{tail}"


def at_time(taf: dict, when: float) -> dict | None:
    """The prevailing forecast period that covers a moment."""
    prevailing, _ = periods(taf)
    return next((f for f in prevailing if (f.get("timeFrom") or 0) <= when < (f.get("timeTo") or 0)), None)


# ---- questions -------------------------------------------------------------------------------------------

_NOW = r"(?: here| outside| right now| now| today| currently| at the (?:airport|field)| at wood county| in bowling green| around here| locally)*"
_WHEN = r"(?: later| today| tonight| this (?:morning|afternoon|evening)| tomorrow(?: morning| afternoon| evening| night)?| in the next (?:few|couple of|\w+) hours?| soon| here| outside| at the (?:airport|field)| for (?:today|tonight|tomorrow|this (?:morning|afternoon|evening)|the next (?:few|\w+) hours?))*"
_Q = r"(?:whats|what is|hows|how is|how are|what are)"
_HERE = rf"{_Q} the weather(?: conditions?)?(?: like| doing)?{_NOW}|{_Q} the (?:wind|winds|ceiling|ceilings|visibility|conditions|clouds|sky|temperature)(?: like| doing)?{_NOW}|(?:the )?(?:current )?weather(?: conditions?| report| check)?{_NOW}|(?:the )?current conditions{_NOW}"
_FORECAST = (
    rf"{_Q} the (?:weather )?forecast(?: like| looking)?{_WHEN}"
    rf"|(?:{_Q}|what will|how will|whats it|what is it) (?:the weather )?(?:going to be|gonna be|be|look|looking|supposed to be|going to do|gonna do)(?: like)?{_WHEN}"
    rf"|(?:the |give me the )?(?:weather )?forecast{_WHEN}"
    rf"|{_Q} the weather(?: like| looking)? (?:later|tonight|tomorrow(?: morning| afternoon| evening| night)?|this (?:afternoon|evening))"
)
_PRECIP = (
    rf"(?:will|is|does) it (?:going to |gonna |supposed to |look like (?:its|it is) going to )?(?:be )?(rain|snow|storm|thunderstorm|drizzle|raining|snowing|storming|precipitate){_WHEN}"
    rf"|(?:any|is there any|are there any|do you see any|is there) (rain|snow|storms?|thunderstorms?|precipitation|weather)(?: coming| expected| in the forecast| on the way| forecast| later)*{_WHEN}"
)
_FLYING = (
    rf"(?:will|is) (?:it|the weather) (?:going to |gonna )?(?:stay|be|remain|hold) (?:vfr|flyable|good|good for flying|good flying weather|okay|okay for flying|okay to fly|fine|clear){_WHEN}"
    rf"|(?:is|will) the weather (?:going to |gonna )?(?:hold|hold up|get worse|get better|change|improve|turn|stay good){_WHEN}"
    rf"|(?:can|could) (?:we|i|they|you) (?:still )?fly{_WHEN}"
    rf"|(?:is it|will it be) (?:good|okay|vfr|flyable)(?: for flying| to fly)?{_WHEN}"
)
_IT = r"(?:it|they|that plane|this plane|that flight|this flight)"
_ARRIVAL = (
    rf"{_Q} the weather (?:like )?(?:going to be |gonna be )?(?:like )?when {_IT} (?:lands?|arrives?|gets? there|gets? in)"
    rf"|(?:what will|how will|whats|what is) the weather (?:be |going to be |gonna be )?(?:like )?(?:at|in) (?:its|the|their) destination when {_IT} (?:lands?|arrives?|gets? there)"
    rf"|{_Q} the forecast (?:at|for|in) (?:its|the|their) destination|{_Q} the forecast where {_IT} (?:is|are|s) (?:going|landing|headed|heading)"
)


# "Tell me the weather", "can you give me the forecast": the question is what follows.
_LEAD = r"^(?:please )?(?:(?:can|could|would) you )?(?:tell me|give me|show me|get me|check|read me|i want to know|i wanna know|do you know|let me know|what about|how about)(?: about)? "
# A named place: "... at Detroit Metro right now", "... in Toledo tonight".
_AT = re.compile(r" (?:at|in|for|over|around|near) ")
_AFTER_PLACE = r"((?: right now| now| today| currently| tonight| later| this (?:morning|afternoon|evening)| tomorrow(?: morning| afternoon| evening| night)?| in the next \w+ hours?)*)$"
_NOT_A_PLACE = re.compile(r"^(?:its|their|the destination|the next|the airport|the field|today|tonight|tomorrow|this |flying|a |an )")
_WEATHER_WORD = re.compile(r"\b(?:weather|wind|winds|windy|rain|raining|snow|snowing|storms?|forecast|visibility|ceilings?|clouds?|cloudy|temperature|conditions?|vfr|ifr|foggy|fog|cold|hot|warm|sunny|icing|freezing)\b")


def wants(text: str) -> tuple[str, str] | None:
    """(kind, the matched text) if a normalized transcript is plainly one of the weather questions."""
    asked = re.sub(_LEAD, "", text)
    for kind, pattern in (("arrival", _ARRIVAL), ("precip", _PRECIP), ("flying", _FLYING), ("forecast", _FORECAST), ("here", _HERE)):
        if re.fullmatch(pattern, asked):
            return kind, text
    return None


def wants_at(text: str, ctx: dict | None = None) -> tuple[str, str, dict] | None:
    """(kind, the question without the place, the airport) for a weather question about a named place.

    "Tell me the weather at Detroit Metro right now", "will it rain in Toledo tonight". The place
    has to be an airport the list knows (US and Canada); otherwise None, and Aivana is asked.
    """
    near = where(ctx or {})
    for cut in _AT.finditer(text):
        m = re.fullmatch(r"(.+?)" + _AFTER_PLACE, text[cut.end():])
        if not m or _NOT_A_PLACE.match(m.group(1)):
            continue
        base = text[:cut.start()] + m.group(2)
        asked = wants(base)
        if not asked or asked[0] == "arrival":
            continue
        field = airports.find(m.group(1), near)
        if field:
            return asked[0], base, field
    return None


def mentioned(text: str, ctx: dict | None = None) -> dict | None:
    """The airport named in a weather question of any wording, for Aivana's context. None if none."""
    if not _WEATHER_WORD.search(text):
        return None
    near = where(ctx or {})
    for cut in _AT.finditer(text):
        words = text[cut.end():].split()
        for n in range(min(4, len(words)), 0, -1):
            name = " ".join(words[:n])
            field = None if _NOT_A_PLACE.match(name) else airports.find(name, near)
            if field:
                return field
    return None


def _asked_for(text: str) -> tuple[tuple, str]:
    if re.search(r"\b(storm|storms|storming|thunderstorm|thunderstorms)\b", text):
        return STORM, "thunderstorms"
    if re.search(r"\b(snow|snowing)\b", text):
        return SNOW + ("FZ",), "snow"
    if re.search(r"\b(rain|raining|drizzle)\b", text):
        return RAIN + ("FZ",), "rain"
    return ANY_PRECIP, "rain or snow"


def _from_station(report: dict, noun: str, spot: dict | None = None) -> str:
    """"The nearest forecast is Toledo, 14 miles away." when the station isn't where you are (or at the place asked about)."""
    d = report.get("distanceNm")
    if not d or d < 3:
        return ""
    if spot:
        return f"The nearest {noun} to {airports.spoken(spot)} is {station_name(report)}, {round(d)} miles from it. "
    return f"The nearest {noun} is {station_name(report)}, {round(d)} miles away. "


def _named(report: dict, spot: dict | None) -> str:
    """What to call the station: the airport asked about when the report is from it."""
    return airports.spoken(spot) if spot and (report.get("distanceNm") or 0) < 3 else station_name(report)


async def answer(kind: str, text: str, ctx: dict, plane: dict | None = None, prog: dict | None = None, now: datetime | None = None, spot: dict | None = None) -> str:
    """The spoken answer to one of the weather questions. Never raises.

    `spot` is an airport that was asked about by name (wants_at); without it the answer is for where the user is.
    """
    now = now or datetime.now()
    if kind == "arrival":
        if not plane:
            return "I don't see a plane in the middle of your view. Point at one, or open one from the list."
        if not prog:
            return f"I don't know where {flightinfo.spoken_name(plane)} is going, so I can't look up the weather there."
        dest = prog["destination"]
        taf = await for_airport(dest.get("icao") or "")
        eta = prog.get("eta")
        if taf and eta:
            period = at_time(taf, eta.timestamp())
            if period:
                return f"When it gets to {place(dest)}, around {spoken_clock(eta)} your time by my estimate, the forecast is: {describe_period(period)}"
        if taf:
            return f"The forecast for {place(dest)}: {summary(taf, now, 6)}"
        report = (await flightinfo.weather(plane, prog)).get("destination")
        return f"There's no forecast for {place(dest)}. Right now it has: {describe_metar(report)}" if report else f"I couldn't get a forecast for {place(dest)}."

    lat, lon = (spot["lat"], spot["lon"]) if spot else where(ctx)
    there = f" for {airports.spoken(spot)}" if spot else ""
    if kind == "here":
        report = await nearest("metar", lat, lon)
        if not report:
            return f"I couldn't get a weather report{there} just now."
        return f"{_from_station(report, 'weather station', spot)}{_named(report, spot)} right now: {describe_metar(report)}"

    taf = await nearest("taf", lat, lon)
    if not taf:
        return f"I couldn't get a forecast{there} just now."
    start, end, label = window(text, now)
    if kind == "precip":
        codes, noun = _asked_for(text)
        return precipitation(taf, now, start, end, label, codes, noun)
    if kind == "flying":
        return flying(taf, now, start, end, label)
    hours = max(1.0, (end - now).total_seconds() / 3600)
    lead = f"{_named(taf, spot)} forecast"
    if start > now + timedelta(minutes=30):
        # A later window ("tonight", "tomorrow"): read the forecast from when it starts.
        return f"{_from_station(taf, 'forecast', spot)}{lead} for {label}. {summary(taf, start, (end - start).total_seconds() / 3600)}"
    return f"{_from_station(taf, 'forecast', spot)}{lead}. {summary(taf, now, hours)}"


async def context_lines(ctx: dict, now: datetime | None = None, spot: dict | None = None) -> list[str]:
    """Weather near the user and the forecast, as lines for Aivana's context. With `spot`, also the weather at that airport."""
    now = now or datetime.now()
    lat, lon = where(ctx)
    report, taf = await asyncio.gather(nearest("metar", lat, lon), nearest("taf", lat, lon), return_exceptions=True)
    lines = []
    if spot:
        there, there_taf = await asyncio.gather(nearest("metar", spot["lat"], spot["lon"]), nearest("taf", spot["lat"], spot["lon"]), return_exceptions=True)
        if isinstance(there, dict):
            lines.append(f"Weather at {airports.spoken(spot)} now (report from {station_name(there)}, {round(there.get('distanceNm', 0))} miles from it): {describe_metar(there)}")
        if isinstance(there_taf, dict):
            lines.append(f"Forecast for {airports.spoken(spot)} ({station_name(there_taf)}; official airport forecast): {summary(there_taf, now)}")
    if isinstance(report, dict):
        lines.append(f"Weather near the user now ({station_name(report)}, {round(report.get('distanceNm', 0))} miles away): {describe_metar(report)}")
    if isinstance(taf, dict):
        lines.append(f"Forecast ({station_name(taf)}, {round(taf.get('distanceNm', 0))} miles away; official airport forecast): {summary(taf, now)} Raw: {taf.get('rawTAF', '')}")
    return lines
