"""Pulling callsigns and position reports out of transcribed radio calls.

    "Delta eighteen thirty, descend and maintain four thousand"   -> DAL1830
    "November three three seven Bravo Golf, traffic two o'clock"  -> N337BG
    "Archer niner zero one Bravo Golf, left downwind runway two eight"
                                                                  -> 901BG, leg "left downwind", runway 28

Whisper writes the same call many ways ("Delta 1830", "Delta eighteen thirty", "N337BG", "November
337 Bravo Golf"), so everything is first reduced to one form: phonetic letters to letters, number
words to digits. What comes out are *tokens*: full callsigns where the airline is known, tail-number
fragments otherwise. The phone matches tokens to the planes it knows about (it has the traffic; this
side doesn't).
"""
import re

PHONETIC = {
    "alpha": "A", "alfa": "A", "bravo": "B", "charlie": "C", "delta": "D", "echo": "E", "foxtrot": "F", "golf": "G",
    "hotel": "H", "india": "I", "juliet": "J", "juliett": "J", "kilo": "K", "lima": "L", "mike": "M", "november": "N",
    "oscar": "O", "papa": "P", "quebec": "Q", "romeo": "R", "sierra": "S", "tango": "T", "uniform": "U", "victor": "V",
    "whiskey": "W", "whisky": "W", "xray": "X", "x-ray": "X", "yankee": "Y", "zulu": "Z",
}
DIGITS = {"zero": 0, "oh": 0, "one": 1, "two": 2, "three": 3, "tree": 3, "four": 4, "five": 5, "fife": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "niner": 9}
TEENS = {"ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19}
TENS = {"twenty": 20, "thirty": 30, "forty": 40, "fourty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90}

# What controllers and pilots call an airline -> the ICAO code its callsigns start with. Hand-kept:
# add whatever turns up around Toledo. Longest names are tried first ("air canada" before "air").
AIRLINES = {
    "delta": "DAL", "american": "AAL", "united": "UAL", "southwest": "SWA", "speedbird": "BAW", "brickyard": "RPA",
    "blue streak": "JIA", "bluestreak": "JIA", "endeavor": "EDV", "envoy": "ENY", "skywest": "SKW", "sky west": "SKW",
    "fedex": "FDX", "fed ex": "FDX", "ups": "UPS", "jetblue": "JBU", "jet blue": "JBU", "spirit wings": "NKS", "spirit": "NKS",
    "frontier flight": "FFT", "frontier": "FFT", "alaska": "ASA", "air canada": "ACA", "jazz": "JZA", "rouge": "ROU",
    "piedmont": "PDT", "commutair": "UCA", "commute air": "UCA", "air wisconsin": "AWI", "wisconsin": "AWI",
    "mesa": "ASH", "air shuttle": "ASH", "lindbergh": "GJS", "gojet": "GJS", "execjet": "EJA", "exec jet": "EJA",
    "flexjet": "LXJ", "flex jet": "LXJ", "allegiant": "AAY", "sun country": "SCX", "giant": "GTI", "connie": "CKS",
    "westjet": "WJA", "west jet": "WJA", "porter": "POE", "lufthansa": "DLH", "air france": "AFR", "klm": "KLM",
    "virgin": "VIR", "emirates": "UAE", "cargolux": "CLX", "polar": "PAC", "atlas": "GTI", "amerijet": "AJT",
    "reach": "RCH", "prairie": "PRY",
}
# Words that introduce a tail number said without "November": the aircraft's type or role.
TYPE_WORDS = {
    "archer", "seminole", "skyhawk", "cessna", "cherokee", "warrior", "piper", "cirrus", "bonanza", "baron", "citation",
    "learjet", "lear", "gulfstream", "challenger", "falcon", "mooney", "diamond", "skylane", "arrow", "saratoga", "seneca",
    "caravan", "pilatus", "helicopter", "lifeguard", "medevac", "experimental", "king air", "kingair", "cardinal",
    "centurion", "comanche", "navajo", "aztec", "malibu", "meridian", "twin cessna", "beech", "beechjet", "hawker",
    "phenom", "embraer", "tbm", "sportcruiser", "decathlon", "cub", "champ", "stinson", "grumman", "tiger", "robinson",
    "twin star", "duchess", "sundowner", "musketeer", "skymaster", "stationair", "skywagon", "bell", "airbus", "boeing",
}
AIRLINER_MODELS = {"717", "727", "737", "747", "757", "767", "777", "787", "220", "319", "320", "321", "330", "340", "350", "380", "175", "190"}
LEG_WORDS = ("upwind", "crosswind", "downwind", "base", "final")
RUNWAYS = {"10", "28", "18", "36"}  # Wood County's; others are passed through as heard


BREAK = "|"  # where a sentence or clause ended (only when asked for)


def _normalize(text: str, breaks: bool = False) -> list[str]:
    """Lowercase words, punctuation gone, numbers kept as written ("4,000" -> "4000").

    With `breaks`, the end of a sentence or clause is kept as a "|" word, so that a number is not
    run together with whatever the next sentence starts with ("Skywest 4129. Seven..." is flight
    4129, not 41297).
    """
    t = text.lower().replace("’", "'")
    t = re.sub(r"(?<=\d),(?=\d{3}\b)", "", t)  # thousands separators
    t = re.sub(r"(?<=\d)-(?=\d)", " ", t)  # "3-4-0" -> "3 4 0"
    if breaks:
        t = re.sub(r"[.,;:!?]+(?=\s|$)", f" {BREAK} ", t)
    t = re.sub(r"[^a-z0-9'| ]+" if breaks else r"[^a-z0-9' ]+", " ", t)
    return t.split()


def _spoken(words: list[str]) -> list[str]:
    """Number words and phonetic letters turned into what they stand for, token by token.

    Digits come out one group per spoken group: "eighteen thirty" -> ["18", "30"], "one two three" ->
    ["1", "2", "3"], "four thousand" -> ["4000"]. Letters come out as single capitals.
    Everything else passes through unchanged.
    """
    out: list[str] = []
    i = 0
    while i < len(words):
        w = words[i]
        nxt = words[i + 1] if i + 1 < len(words) else ""
        if w in PHONETIC:
            out.append(PHONETIC[w])
        elif w in TENS:
            if nxt in DIGITS and DIGITS[nxt] > 0 and nxt != "oh":
                out.append(str(TENS[w] + DIGITS[nxt]))
                i += 1
            else:
                out.append(str(TENS[w]))
        elif w in TEENS:
            out.append(str(TEENS[w]))
        elif w in DIGITS:
            value = DIGITS[w]
            if nxt == "thousand":
                value, i = value * 1000, i + 1
                # "four thousand five hundred"
                if i + 2 < len(words) and words[i + 1] in DIGITS and words[i + 2] == "hundred":
                    value, i = value + DIGITS[words[i + 1]] * 100, i + 2
            elif nxt == "hundred":
                value, i = value * 100, i + 1
            out.append(str(value))
        else:
            out.append(w)
        i += 1
    return out


def _join_number(tokens: list[str], start: int) -> tuple[str, int]:
    """Digits (and a trailing letter or two) starting at `start`, run together: flight numbers and tails.

    Returns (text, index after it). "18","30" -> "1830"; "3","3","7","B","G" -> "337BG".
    """
    chars = ""
    i = start
    # Written in one piece: "570u" (Whisper's "Skyhawk 570U").
    if i < len(tokens) and re.fullmatch(r"\d{1,5}[a-z]{1,2}", tokens[i]):
        return tokens[i].upper(), i + 1
    while i < len(tokens) and tokens[i].isdigit() and len(chars) + len(tokens[i]) <= 5:
        chars += tokens[i]
        i += 1
    letters = 0
    while chars and i < len(tokens) and len(tokens[i]) == 1 and tokens[i].isalpha() and tokens[i].isupper() and letters < 2:
        chars += tokens[i]
        letters += 1
        i += 1
    return chars, i


_AIRLINE_NAMES = sorted(AIRLINES, key=lambda n: -len(n.split()))


def callsign_tokens(text: str) -> list[str]:
    """Every callsign or tail-number fragment mentioned in a call, in the order heard, without repeats."""
    words = _normalize(text, breaks=True)
    found: list[str] = []

    def add(token: str):
        token = token.upper()
        if token and token not in found:
            found.append(token)

    # Callsigns Whisper already wrote out in one piece: "DAL1830", "N337BG".
    for m in re.finditer(r"\b([a-z]{3}\d{1,4}[a-z]?|n\d{1,5}[a-z]{0,2})\b", " ".join(words)):
        if any(ch.isdigit() for ch in m.group(1)):
            add(m.group(1))

    # Airline radio names: on the raw words, because "delta" must stay an airline here, not the letter D.
    i = 0
    while i < len(words):
        name = next((n for n in _AIRLINE_NAMES if words[i : i + len(n.split())] == n.split()), None)
        if name:
            after = _spoken(words[i + len(name.split()) : i + len(name.split()) + 6])
            number, _ = _join_number(after, 0)
            # "Follow the Southwest 737": an aircraft model after "the"/"a", not a flight number.
            described = i > 0 and words[i - 1] in ("the", "a", "that", "another") and number in AIRLINER_MODELS
            if number and number[0].isdigit() and 1 <= len(re.sub(r"\D", "", number)) <= 4 and not described:
                add(AIRLINES[name] + number)
                i += len(name.split())
                continue
        i += 1

    # Tail numbers: "November 337 Bravo Golf", or a type word followed by one ("Archer 901 Bravo Golf").
    tokens = _spoken(words)
    for j, tok in enumerate(tokens):
        two = f"{tokens[j]} {tokens[j + 1]}" if j + 1 < len(tokens) else ""
        if tok == "N" or tok == "november":
            tail, _ = _join_number(tokens, j + 1)
            if len(tail) >= 2 and tail[0].isdigit():
                add("N" + tail)
        elif tok in TYPE_WORDS or two in TYPE_WORDS:
            start = j + (2 if two in TYPE_WORDS else 1)
            if start < len(tokens) and tokens[start] in ("N", "november"):
                continue  # the November branch handles it
            tail, _ = _join_number(tokens, start)
            # A fragment needs a digit and at least 3 characters to mean anything ("Archer 1BG", "Skyhawk 734").
            if len(tail) >= 3 and tail[0].isdigit():
                add(tail)
    return found


def position_report(text: str) -> tuple[str | None, str | None]:
    """(leg, runway) from a pattern call: ("left downwind", "28"). Either can be None."""
    tokens = _spoken(_normalize(text))
    leg = None
    for i, tok in enumerate(tokens):
        if tok in LEG_WORDS:
            # "base" and "final" are ordinary words too ("final approach fix", "data base"): they count
            # with a side ("left base"), a runway nearby, or the usual pattern phrasing around them.
            side = tokens[i - 1] if i > 0 and tokens[i - 1] in ("left", "right") else None
            around = tokens[max(0, i - 3) : i + 4]
            pattern_talk = side or "runway" in around or tok in ("downwind", "upwind", "crosswind") or any(w in around for w in ("turning", "short", "mile", "midfield", "entering", "on"))
            if pattern_talk:
                leg = f"{side} {tok}" if side else tok
                break
    runway = None
    for i, tok in enumerate(tokens):
        if tok == "runway" and i + 1 < len(tokens):
            number, end = _join_number(tokens, i + 1)
            digits = re.sub(r"\D", "", number)
            if 1 <= len(digits) <= 2:
                runway = digits.zfill(2) if len(digits) == 1 else digits
                suffix = tokens[end] if end < len(tokens) else ""
                if suffix in ("left", "right", "center") and runway not in RUNWAYS:
                    runway += suffix[0].upper()
                break
    return leg, runway


# Who a plane is sent to next: "contact Detroit Approach one two four point zero five".
HANDOFF_KINDS = {
    "tower": "tower", "ground": "ground", "approach": "approach", "arrival": "approach", "departure": "departure",
    "center": "center", "centre": "center", "clearance": "clearance", "ramp": "ramp", "advisory": "advisory",
}
_HANDOFF_FILLER = {"the", "your", "to", "over", "now"}
# Aviation voice frequencies, MHz.
_VOICE_BAND = (118, 137)


def _frequency(tokens: list[str]) -> str | None:
    """"124.05" from the start of spoken-number tokens: ["1","2","4","point","0","5"], ["124","05"], ["12405"]."""
    i = 0
    while i < len(tokens) and tokens[i] in ("on", "at", "frequency", "now"):
        i += 1
    whole = ""
    while i < len(tokens) and tokens[i].isdigit() and len(whole) + len(tokens[i]) <= 6:
        whole += tokens[i]
        i += 1
    frac = ""
    if i < len(tokens) and tokens[i] in ("point", "decimal"):
        i += 1
        while i < len(tokens) and tokens[i].isdigit() and len(frac) + len(tokens[i]) <= 3:
            frac += tokens[i]
            i += 1
    elif len(whole) in (4, 5, 6):  # said without "point", or written "124.05" (the dot is gone by now)
        whole, frac = whole[:3], whole[3:]
    if len(whole) != 3 or not frac or not _VOICE_BAND[0] <= int(whole) < _VOICE_BAND[1]:
        return None
    return f"{whole}.{frac}"


def handoff(text: str) -> dict | None:
    """Who a call sends a plane to: {"kind": "approach", "place": "detroit", "freq": "124.05"}, or None.

    `kind` is tower, ground, approach, departure, center, clearance, ramp or advisory; `place` and
    `freq` are None when the controller didn't say them ("contact tower"). Only the instruction
    counts ("contact", "monitor", "switch to"), not a pilot's "over to tower".
    """
    words = _normalize(text)
    for i, w in enumerate(words):
        if w in ("contact", "monitor"):
            j = i + 1
        elif w == "switch" and words[i + 1 : i + 2] == ["to"]:
            j = i + 2
        else:
            continue
        place: list[str] = []
        kind = None
        while j < len(words) and len(place) <= 3:
            if words[j] in HANDOFF_KINDS:
                kind = HANDOFF_KINDS[words[j]]
                j += 1
                break
            if words[j].isdigit() or words[j] in DIGITS or words[j] in ("on", "at", "point"):
                break
            if words[j] not in _HANDOFF_FILLER:
                place.append(words[j])
            j += 1
        if not kind:
            continue
        return {"kind": kind, "place": " ".join(place) or None, "freq": _frequency(_spoken(words[j:]))}
    return None


def parse(text: str) -> dict:
    """What a transcribed call says: {"callsignTokens": [...], "reportedLeg": ..., "runway": ..., "handoff": ...}."""
    leg, runway = position_report(text)
    return {"callsignTokens": callsign_tokens(text), "reportedLeg": leg, "runway": runway, "handoff": handoff(text)}


_RADIO_NAMES = {}
for _name, _code in AIRLINES.items():
    _RADIO_NAMES.setdefault(_code, _name.title())
_LETTERS = {v: k.title() for k, v in PHONETIC.items() if k not in ("alfa", "juliett", "whisky", "x-ray")}


def spoken_form(callsign: str) -> str:
    """A callsign the way it is said on the radio: "DAL1830" -> "Delta 1830", "N337BG" -> "November 337 Bravo Golf".

    Used to tell Whisper which aircraft to expect; anything unrecognized is returned as it is.
    """
    cs = callsign.strip().upper()
    m = re.fullmatch(r"([A-Z]{3})(\d{1,4}[A-Z]?)", cs)
    if m and m.group(1) in _RADIO_NAMES:
        return f"{_RADIO_NAMES[m.group(1)]} {m.group(2)}"
    m = re.fullmatch(r"N(\d{1,5})([A-Z]{0,2})", cs)
    if m:
        return " ".join(["November", m.group(1), *(_LETTERS.get(ch, ch) for ch in m.group(2))])
    return cs
