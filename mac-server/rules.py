"""Commands the server answers itself, instantly, without asking Aivana.

Aivana takes 3-6 seconds per call (measured 2026-11-20). That's fine for a real question and far too
slow for "next page". So anything with one obvious meaning is matched here first: paging, opening
and closing the list, simple filters, sorting, radar zoom, the runway in use, and "what's that
plane?" (answered from the plane's own data). Everything else falls through to Aivana.

Patterns are deliberately narrow: a near miss should go to Aivana, not be half-understood here.
"""
import re

import radiotalk
from speech import describe

NUMBER_WORDS = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8,
    "nine": 9, "niner": 9, "ten": 10, "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60,
    "seventy": 70, "eighty": 80, "ninety": 90, "hundred": 100,
}
RUNWAY_WORDS = {"one zero": "10", "ten": "10", "two eight": "28", "twenty eight": "28", "one eight": "18", "eighteen": "18", "three six": "36", "thirty six": "36"}
KIND_WORDS = {
    "helicopters": {"kind": "helicopters"}, "helicopter": {"kind": "helicopters"}, "choppers": {"kind": "helicopters"},
    "jets": {"kind": "jets"}, "jet": {"kind": "jets"},
    "props": {"kind": "props"}, "propeller planes": {"kind": "props"}, "prop planes": {"kind": "props"},
    "military": {"kind": "military"}, "military planes": {"kind": "military"}, "military aircraft": {"kind": "military"},
    "medical": {"kind": "medical"}, "medical flights": {"kind": "medical"}, "medevac": {"kind": "medical"}, "air ambulances": {"kind": "medical"},
    "emergencies": {"kind": "emergencies"}, "emergency": {"kind": "emergencies"},
    "bgsu": {"fleet": "bgsu"}, "bgsu planes": {"fleet": "bgsu"}, "bgsu aircraft": {"fleet": "bgsu"}, "bgsu trainers": {"fleet": "bgsu"},
    "bowling green planes": {"fleet": "bgsu"}, "falcons": {"fleet": "bgsu"}, "trainers": {"fleet": "bgsu"},
    "the trainers": {"fleet": "bgsu"}, "our planes": {"fleet": "bgsu"}, "school planes": {"fleet": "bgsu"},
    "planes on the ground": {"onGround": "only"},
}
_KINDS = "|".join(sorted(map(re.escape, KIND_WORDS), key=len, reverse=True))
_SORT = {"altitude": "altitude", "height": "altitude", "distance": "distance", "range": "distance", "speed": "speed"}
_ORDER = {
    "ascending": "asc", "descending": "desc", "highest first": "desc", "lowest first": "asc", "closest first": "asc",
    "nearest first": "asc", "farthest first": "desc", "fastest first": "desc", "slowest first": "asc",
}


def normalize(text: str) -> str:
    """Lowercase, no punctuation, single spaces: what Whisper writes varies, the words don't."""
    t = text.lower().replace("’", "'").replace("'", "")
    t = re.sub(r"[^a-z0-9 ]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def _number(word: str) -> int | None:
    if word.isdigit():
        return int(word)
    return NUMBER_WORDS.get(word)


AR_RANGE_MIN_KM = 5
AR_RANGE_MAX_KM = 200  # the app's own limit (MAX_AR_RADIUS_KM): the bar's data is asked for every few seconds


def _amount(words: str) -> int | None:
    """A number said or written: "75", "seventy five", "a hundred", "one hundred"."""
    words = words.strip()
    if words.isdigit():
        return int(words)
    parts = [w for w in words.split() if w not in ("a", "and")]
    if not parts or any(p not in NUMBER_WORDS for p in parts):
        return None
    values = [NUMBER_WORDS[p] for p in parts]

    def under_hundred(v: list[int]) -> int | None:
        if len(v) == 1 and v[0] < 100:
            return v[0]
        if len(v) == 2 and v[0] in (20, 30, 40, 50, 60, 70, 80, 90) and 1 <= v[1] <= 9:
            return v[0] + v[1]
        return None

    if 100 in values:
        # "a hundred", "two hundred", "one hundred fifty", "a hundred and seventy five"
        at = values.index(100)
        hundreds = 1 if at == 0 else values[0] if at == 1 and 1 <= values[0] <= 9 else None
        rest = 0 if at == len(values) - 1 else under_hundred(values[at + 1 :])
        return None if hundreds is None or rest is None else hundreds * 100 + rest
    # "one fifty", "one seventy five": how people say 150 and 175.
    if len(values) >= 2 and values[0] == 1 and values[1] in (20, 30, 40, 50, 60, 70, 80, 90):
        rest = under_hundred(values[1:])
        return None if rest is None else 100 + rest
    return under_hundred(values)


def _reply(answer: str, *actions: dict) -> dict:
    return {"answer": answer, "actions": list(actions)}


def quick(text: str, context: dict) -> dict | None:
    """{answer, actions} for a command with one obvious meaning, else None (ask Aivana)."""
    t = normalize(text)
    t = re.sub(r"^(please|hey|ok|okay|can you|could you|would you)\s+", "", t)
    t = re.sub(r"\s+(please|now|for me)$", "", t)
    if not t:
        return None

    radio = radiotalk.quick(t, context)
    if radio:
        return radio

    if re.fullmatch(r"next( page)?|page down|more|keep going", t):
        return _reply("Next page.", {"type": "page", "direction": "next"})
    if re.fullmatch(r"(previous|prev|last)( page)?|page up|go back a page|back a page", t):
        return _reply("Previous page.", {"type": "page", "direction": "prev"})
    if re.fullmatch(r"(close|hide|dismiss|exit)( the)?( plane| traffic)? list|close it|list off", t):
        return _reply("List closed.", {"type": "hide_list"})
    if re.fullmatch(r"(show|open|bring up|pull up)( me)?( the)?( plane| traffic)? list|list on", t):
        return _reply("", {"type": "show_list"})
    if re.fullmatch(r"(clear|reset|remove|drop)( the| all| all the)?( filters?)|no filters?|show (me )?(everything|all( the)? (planes|aircraft|traffic))", t):
        return _reply("", {"type": "clear_filter"}, {"type": "show_list"})
    if re.fullmatch(r"back|go back|back to( the)? list|close( the| this| that)? plane", t):
        return _reply("", {"type": "close_plane"})

    m = re.fullmatch(r"sort(ed)? by (altitude|height|distance|range|speed)(?: (.+))?", t)
    if m and (m.group(3) is None or m.group(3) in _ORDER):
        action = {"type": "sort", "by": _SORT[m.group(2)]}
        if m.group(3):
            action["order"] = _ORDER[m.group(3)]
        return _reply(f"Sorted by {_SORT[m.group(2)]}.", action)

    m = re.fullmatch(r"(?:open|select|pick|show me)(?: number| row| plane)? (\w+)|number (\w+)", t)
    if m:
        n = _number(m.group(1) or m.group(2))
        if n and 1 <= n <= 8:
            return _reply("", {"type": "open_row", "n": n})

    m = re.fullmatch(r"zoom(?: the)? radar(?: in| out)?(?: to)? (\w+)(?: nautical)? ?(miles?|nm|kilometers?|km)", t)
    if m and _number(m.group(1)):
        value = _number(m.group(1))
        nm = round(value / 1.852) if m.group(2).startswith("k") else value
        if 1 <= nm <= 250:
            return _reply(f"Radar at {nm} miles.", {"type": "radar_range", "nm": nm})
    if re.fullmatch(r"(reset|auto|automatic)( the)? radar( range| zoom)?|radar auto(matic)?|reset( the)? zoom", t):
        return _reply("Radar back to automatic.", {"type": "radar_range", "nm": 0})

    # How far out the compass bar and the sky show planes ("set the range to 75 kilometers").
    _what = r"(?:bar |view |viewing |plane |planes |ar |sky |compass |headband |display )?(?:range|radius|distance)"
    m = re.fullmatch(
        rf"(?:(?:set|change|make|put|switch|extend|widen|increase|expand|raise|reduce|narrow|shrink|lower|bring|take|push)(?: the| my)? {_what}(?: out| in| down| up)?(?: to)?|{_what}(?: to| of)?) (.+?)(?: (nautical miles?|miles?|nm|kilometers?|kilometres?|km|k|clicks))?",
        t,
    )
    if m and _amount(m.group(1)) is not None:
        value = _amount(m.group(1))
        km = round(value * 1.852) if (m.group(2) or "").startswith(("mile", "nautical", "nm")) else value
        if km > AR_RANGE_MAX_KM:
            return _reply(f"The most the bar can show is {AR_RANGE_MAX_KM} kilometers, so that's what I set. Planes farther out are in the list.", {"type": "ar_range", "km": AR_RANGE_MAX_KM})
        km = max(AR_RANGE_MIN_KM, km)
        return _reply(f"Range {km} kilometers.", {"type": "ar_range", "km": km})
    if re.fullmatch(rf"(?:reset|default|normal)(?: the| my)? {_what}|(?:set |put )?(?:the |my )?{_what} (?:back )?to (?:the )?(?:default|normal)|reset (?:the |my )?{_what}", t):
        return _reply("Range back to 50 kilometers.", {"type": "ar_range", "km": 0})
    if re.fullmatch(rf"(?:whats|what is)(?: the| my)? {_what}|how far (?:can i see|does the bar (?:go|reach|show)|out (?:can i see|does it (?:go|show)))", t):
        km = context.get("arRadiusKm")
        return _reply(f"The bar shows planes within {round(km)} kilometers. You can set it anywhere up to {AR_RANGE_MAX_KM}." if km else "I don't know the range right now.")

    m = re.fullmatch(r"(?:(?:were|we are|theyre|they are) (?:using|on|landing|landing on) |(?:switch|change)(?: to| the runway to)? |(?:set )?(?:the )?(?:active )?)runway (?:to )?(.+?)(?: is active| in use)?", t)
    if m:
        spoken = m.group(1).strip()
        runway = spoken if spoken in ("10", "28", "18", "36") else RUNWAY_WORDS.get(spoken)
        if runway:
            return _reply(f"Runway {' '.join(runway)} in use.", {"type": "set_runway", "runway": runway})

    if re.fullmatch(r"(?:auto|automatic) runway|runway (?:auto|automatic)|(?:detect|figure out|work out|find)(?: the)? (?:active )?runway(?: in use)?(?: again| yourself| from(?: the)? traffic)?|(?:set|switch|put)(?: the)? (?:active )?runway (?:back )?(?:to|on) auto(?:matic)?", t):
        return _reply("Runway back to automatic.", {"type": "set_runway", "runway": "auto"})

    m = re.fullmatch(rf"(?:show|list|find|display|where are|give me)(?: me)?(?: all)?(?: of)?(?: the)? ({_KINDS})", t)
    if m:
        return _reply("", {"type": "show_list", "filter": dict(KIND_WORDS[m.group(1)])})
    m = re.fullmatch(rf"(?:how many|any|are there any|is there an?|do you see any) ({_KINDS})(?: are)?(?: there| around| nearby| out there| in the air| flying)*", t)
    if m:
        return _reply("", {"type": "count", "filter": dict(KIND_WORDS[m.group(1)])})

    if re.fullmatch(r"(what is|whats|who is|whos|tell me about|identify|what about) (that|this|it)( plane| aircraft| one| helicopter| jet)?|what am i looking at|what plane is (that|this)|what(s| is) (that|this) (plane|aircraft|one)", t):
        focus = context.get("focus") or context.get("opened")
        if focus:
            return _reply(describe(focus))
        return _reply("I don't see a plane in the middle of your view. Point at one, or ask me to show the list.")
    return None
