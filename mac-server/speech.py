"""Turning plane data into things that sound right when read aloud."""
import re

KM_PER_NM = 1.852
COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"]


def compass_word(bearing_deg: float) -> str:
    return COMPASS[round((bearing_deg % 360) / 45) % 8]


def miles(distance_km: float | None) -> str:
    """Distance for speech, in nautical miles ("miles" is what pilots say)."""
    if distance_km is None:
        return ""
    nm = distance_km / KM_PER_NM
    if nm < 1:
        return "less than a mile"
    if nm < 10:
        text = f"{nm:.1f}".rstrip("0").rstrip(".")
        return "1 mile" if text == "1" else f"{text} miles"
    return f"{round(nm)} miles"


def feet(altitude_ft: float | None) -> str:
    if altitude_ft is None:
        return ""
    rounded = round(altitude_ft / 100) * 100
    return f"{rounded:,} feet"


def spoken_name(plane: dict) -> str:
    """"Southwest 1234" for an airline flight; a tail number spelled out so TTS doesn't mangle it."""
    callsign = (plane.get("callsign") or "").strip().upper()
    airline = plane.get("airline")
    m = re.fullmatch(r"[A-Z]{3}(\d+[A-Z]?)", callsign)
    if airline and m:
        short = re.sub(r"\s+(Air ?lines?|Airways|Air Lines)$", "", airline).strip() or airline
        return f"{short} {m.group(1)}"
    ident = callsign or (plane.get("registration") or "").upper()
    return " ".join(ident) if ident else "an aircraft"


def article(noun: str) -> str:
    return "an" if noun[:1].lower() in "aeiou" else "a"


def describe(plane: dict) -> str:
    """One or two sentences about a plane, from its data alone. Used for "what's that plane?"."""
    kind = plane.get("typeName") or plane.get("typeCode") or ("helicopter" if plane.get("kind") == "helicopter" else "")
    owner = "BGSU " if plane.get("tag") == "BGSU" else ""
    flags = [w for w, on in (("medical", plane.get("medical")), ("military", plane.get("military"))) if on]
    what = " ".join(flags + [f"{owner}{kind}".strip()]).strip()
    first = f"That's {spoken_name(plane)}"
    if what:
        first += f", {article(what)} {what}"
    origin, destination = plane.get("origin"), plane.get("destination")
    if origin and destination:
        first += f", from {origin} to {destination}"
    first += "."

    where = []
    if plane.get("distanceKm") is not None and plane.get("bearingDeg") is not None:
        where.append(f"{miles(plane['distanceKm'])} {compass_word(plane['bearingDeg'])}")
    if plane.get("onGround"):
        where.append("on the ground")
    elif plane.get("altitudeFt") is not None:
        rate = plane.get("verticalRateFpm") or 0
        trend = ", climbing" if rate >= 300 else ", descending" if rate <= -300 else ""
        where.append(f"at {feet(plane['altitudeFt'])}{trend}")
    second = f" It's {' '.join(where)}." if where else ""
    leg = plane.get("leg")
    third = f" {leg.replace(' · RWY ', ' for runway ')}." if leg else ""
    if plane.get("emergency"):
        third += " It's declaring an emergency."
    return (first + second + third).strip()
