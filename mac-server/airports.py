"""Which airfield a point is at: for naming where a plane left from.

Small planes mostly file no flight plan (flying visually needs none in the US), so nobody publishes
where a Cessna came from. Where its track starts says it anyway, and this names that place.

The list is data/airports.json, made by build_airports.py from OurAirports (public domain):
rows of [code, name, city, lat, lon, elevationFt, kind], kind "L" large, "M" medium, "S" small
public-use, "P" private strip, "H" heliport. The phone has the same rules over a regional copy
(app/android/src/airports/lookup.ts): keep the two in step.
"""
import json
import os
import re
from datetime import datetime, timedelta

from flightinfo import distance_nm

PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "airports.json")
# A private strip is believed only when the point is right on it and no public field is about as close.
PRIVATE_WITHIN_NM = 1.0
# A sighting at an airfield this close to the route's origin airport is a takeoff from that airport.
AT_ORIGIN_NM = 15
# A heliport only for a helicopter, and only when it is on top of it.
HELIPORT_WITHIN_NM = 0.5
_KEYS = ("code", "name", "city", "lat", "lon", "elevationFt", "kind")

_rows: list[list] | None = None


def _load() -> list[list]:
    global _rows
    if _rows is None:
        try:
            with open(PATH, encoding="utf-8") as f:
                _rows = json.load(f)
        except (OSError, ValueError):
            _rows = []  # no list: places fall back to the nearest weather station, as before
    return _rows


def use(rows: list[list]) -> None:
    """Replace the list (tests)."""
    global _rows, _words
    _rows = rows
    _words = None


def nearest(lat: float, lon: float, max_nm: float = 5.0, helicopter: bool = False) -> dict | None:
    """The airfield a point most likely belongs to, within max_nm, with `distanceNm`. None if none.

    Public airports first: a private strip wins only from very close and when the nearest public
    field is clearly farther; heliports count only for helicopters.
    """
    span = max_nm / 60 + 0.01  # degrees of latitude
    best: dict[str, tuple[float, list]] = {}
    for row in _load():
        if abs(row[3] - lat) > span:
            continue
        group = "public" if row[6] in "LMS" else "private" if row[6] == "P" else "heli"
        if group == "heli" and not helicopter:
            continue
        d = distance_nm(lat, lon, row[3], row[4])
        if d <= max_nm and (group not in best or d < best[group][0]):
            best[group] = (d, row)
    public, private, heli = best.get("public"), best.get("private"), best.get("heli")
    pick = public
    if private and private[0] <= PRIVATE_WITHIN_NM and (not public or public[0] > 3 * private[0] + 1):
        pick = private
    if heli and heli[0] <= HELIPORT_WITHIN_NM and (not pick or heli[0] < pick[0]):
        pick = heli
    if not pick:
        return None
    return {**dict(zip(_KEYS, pick[1])), "distanceNm": pick[0]}


# Names people say that the list would not settle on its own: a city with several big airports, a nickname.
_SAID = {"chicago": "ORD", "ohare": "ORD", "midway": "MDW", "new york": "JFK", "washington": "DCA", "dallas": "DFW", "houston": "IAH", "metro": "DTW"}
# An airfield this close to the user is probably the one meant: "Marion" near Bowling Green is Marion, Ohio.
LOCAL_NM = 150
_KIND_RANK = {"L": 4, "M": 2, "S": 1}  # a big airport far away beats a small one nearby with the same name (Toronto)
_words: list[tuple[list, list[str], str]] | None = None


def _plain(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]+", " ", (text or "").lower().replace("'", "").replace("’", ""))).strip()


def find(name: str, near: tuple[float, float] | None = None) -> dict | None:
    """The public airport someone means by a spoken name: "detroit metro", "toledo", "findlay", "dtw".

    Every word said has to be a word (or the start of one) in the airport's name or town. Among
    those, bigger airports and ones within LOCAL_NM of `near` come first, then the nearest. None
    when nothing fits: better no answer than the weather for the wrong place.
    """
    global _words
    said = re.sub(r"^the ", "", _plain(name))
    said = re.sub(r"( international)? (airport|airfield)$| area$", "", said).strip()
    if not said or len(said) < 3:
        return None
    if _words is None:
        _words = [(row, _plain(f"{row[1]} {row[2]}").split(), _plain(row[2])) for row in _load() if row[6] in _KIND_RANK]
    by_code = {row[0]: row for row, _, _ in _words}
    tokens = said.split()
    pick = by_code.get(_SAID.get(said, ""))
    if not pick:
        best = None
        for row, words, city in _words:
            exact = all(t in words for t in tokens)
            # "Metro" for "Metropolitan" counts, but only next to a word that is really there ("detroit metro").
            if not exact and not (any(t in words for t in tokens) and all(any(w == t or (len(t) >= 4 and w.startswith(t)) for w in words) for t in tokens)):
                continue
            d = distance_nm(near[0], near[1], row[3], row[4]) if near else 0.0
            score = _KIND_RANK[row[6]] + (2 if near and d <= LOCAL_NM else 0) + (0.5 if city == said else 0) + (0.25 if exact else 0)
            if best is None or (score, -d) > (best[0], -best[1]):
                best = (score, d, row)
        pick = best[2] if best else None
    if not pick and len(tokens) == 1 and 3 <= len(said) <= 4:
        # A code: "dtw", "kdtw", "1g0".
        pick = by_code.get(said.upper()) or (by_code.get(said[1:].upper()) if len(said) == 4 and said[0] == "k" else None)
    return dict(zip(_KEYS, pick)) if pick else None


def spoken(airport: dict) -> str:
    """"Wood County Airport in Bowling Green"; just the name when it already says where it is."""
    name, city = airport.get("name") or "", airport.get("city") or ""
    if city and city.lower() not in name.lower() and airport.get("kind") != "L":
        return f"{name} in {city}"
    return name


def seen_leaving(plane: dict, prog: dict | None = None, now: datetime | None = None) -> dict | None:
    """The phone's own sighting of this plane leaving an airfield, in the shape of opensky.takeoff().

    The phone watches 250 nm around the user and remembers where each plane was last on the ground
    (app/android/src/departures/), and sends it as the plane's `seenLeaving`:
    {code, name, city, kind, lat, lon, agoMin, how}. It is what the plane's card shows, so it is
    what gets said. `how`: "from" = it stopped on that field and then left (`exact`); "near" = a
    track that starts close to it; "leaving" = seen climbing away from it without having stopped
    (a touch-and-go, or first seen already climbing out), which says where it was, not where the
    flight began (`leaving`, and the time is worked out rather than seen: `approx`).
    """
    seen = plane.get("seenLeaving")
    if not isinstance(seen, dict) or not seen.get("name") or not isinstance(seen.get("agoMin"), (int, float)):
        return None
    ago = max(0.0, float(seen["agoMin"]))
    took = {
        "at": (now or datetime.now()) - timedelta(minutes=ago),
        "agoMin": ago,
        "lat": seen.get("lat"),
        "lon": seen.get("lon"),
        "fromGround": True,
        "atOrigin": False,
        "awayFromOriginNm": None,
        "airport": spoken({k: str(seen.get(k) or "")[:80] for k in ("name", "city", "kind")}),
        "exact": seen.get("how") == "from",
        "leaving": seen.get("how") == "leaving",
        "approx": seen.get("how") == "leaving",
    }
    origin = (prog or {}).get("origin") or {}
    if all(isinstance(v, (int, float)) for v in (origin.get("lat"), origin.get("lon"), took["lat"], took["lon"])):
        took["awayFromOriginNm"] = distance_nm(origin["lat"], origin["lon"], took["lat"], took["lon"])
        took["atOrigin"] = took["awayFromOriginNm"] <= AT_ORIGIN_NM
    return took
