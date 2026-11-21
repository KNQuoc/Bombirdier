"""What the assistant can do besides talk: actions the phone carries out.

The server only decides *which* action; the phone owns the list, the radar and the settings, applies
the action, and (for list actions) says how many planes matched, since only it has all the traffic.

Aivana's strict JSON Schema has no oneOf/anyOf, so an action is one flat object: `type` plus whichever
of the optional fields that type uses. validate_actions() checks the combination.

The radio actions (connect_feed, disconnect_feed, radio_audio, transcript) switch what the phone
plays and shows; the questions around them ("who is it talking to?", "what did they just say?") are
answered on the server from the context, in radiotalk.py.
"""

LIST_KINDS = ["jets", "props", "helicopters", "military", "medical", "emergencies"]
SORT_KEYS = ["distance", "altitude", "speed"]
RUNWAYS = ["10", "28", "18", "36", "auto"]  # "auto" = let the app work it out from the traffic again

FILTER_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "fleet": {"type": "string", "enum": ["bgsu"], "description": "Only BGSU's training planes"},
        "kind": {"type": "string", "enum": LIST_KINDS},
        "airline": {"type": "string", "maxLength": 3, "description": "ICAO airline code, e.g. SWA, DAL, AAL, UAL"},
        "typeCode": {"type": "string", "maxLength": 4, "description": "ICAO aircraft type, e.g. B738, A320, P28A"},
        "minAltFt": {"type": "number"},
        "maxAltFt": {"type": "number"},
        "minDistNm": {"type": "number"},
        "maxDistNm": {"type": "number"},
        "climbing": {"type": "boolean"},
        "descending": {"type": "boolean"},
        "onGround": {"type": "string", "enum": ["hide", "show", "only"]},
        "query": {"type": "string", "maxLength": 12, "description": "Part of a callsign or tail number"},
    },
}

# type -> the fields it needs (besides `type`).
ACTIONS: dict[str, list[str]] = {
    "show_list": [],  # optional: filter (replaces the current one)
    "hide_list": [],
    "set_filter": ["filter"],  # merged into the current filter
    "clear_filter": [],
    "sort": ["by"],  # optional: order
    "page": ["direction"],
    "open_plane": ["query"],  # callsign or tail number
    "open_row": ["n"],  # row number on the page showing, 1-8
    "close_plane": [],
    "count": ["filter"],  # "how many...?" / "any...?": the phone answers with the number
    "radar_range": ["nm"],  # 0 = back to automatic
    "set_runway": ["runway"],
    "sky_filter": [],  # optional: filter (only matching planes are shown in the sky), or fromList; neither = show everything again
    "ar_range": ["km"],  # how far out planes get icons on the compass bar and brackets in the sky; 0 = the default
    "connect_feed": ["feed"],  # start listening to a radio feed (audio + transcript); feed = its id. Optional scope
    "radio_scope": ["state"],  # all | one: every channel of the controller in the transcript, or only the one playing
    "disconnect_feed": [],
    "radio_audio": ["state"],  # on | off | up | down: the live audio, without disconnecting
    "transcript": ["state"],  # show | hide: the scrolling transcript, independent of the audio
}

ACTION_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["type"],
    "properties": {
        "type": {"type": "string", "enum": list(ACTIONS)},
        "filter": FILTER_SCHEMA,
        "by": {"type": "string", "enum": SORT_KEYS},
        "order": {"type": "string", "enum": ["asc", "desc"]},
        "direction": {"type": "string", "enum": ["next", "prev"]},
        "query": {"type": "string", "maxLength": 16},
        "n": {"type": "integer", "minimum": 1, "maximum": 8},
        "nm": {"type": "number", "minimum": 0, "maximum": 250},
        "km": {"type": "number", "minimum": 0, "maximum": 200},
        "fromList": {"type": "boolean", "description": "sky_filter: use the plane list's current filter"},
        "runway": {"type": "string", "enum": RUNWAYS},
        "feed": {"type": "string", "maxLength": 24, "description": "A radio feed id from the context"},
        "state": {"type": "string", "enum": ["on", "off", "up", "down", "show", "hide", "all", "one"]},
        "scope": {"type": "string", "enum": ["facility", "channel"], "description": "connect_feed: transcript of every channel of that controller, or of this one only"},
    },
}

REPLY_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["answer", "actions"],
    "properties": {
        "answer": {"type": "string", "maxLength": 500, "description": "What to say out loud"},
        "actions": {"type": "array", "maxItems": 4, "items": ACTION_SCHEMA},
    },
}

# Which optional fields each type may also carry.
_OPTIONAL = {"show_list": ["filter"], "sort": ["order"], "sky_filter": ["filter", "fromList"], "connect_feed": ["scope"]}


def validate_actions(raw) -> list[dict]:
    """Keeps well-formed actions, trimmed to the fields their type uses; drops the rest."""
    out: list[dict] = []
    if not isinstance(raw, list):
        return out
    for a in raw:
        if not isinstance(a, dict) or a.get("type") not in ACTIONS:
            continue
        kind = a["type"]
        needed = ACTIONS[kind]
        if any(a.get(field) is None for field in needed):
            continue
        clean = {"type": kind}
        for field in needed + _OPTIONAL.get(kind, []):
            if a.get(field) is not None:
                clean[field] = a[field]
        if "filter" in clean and not isinstance(clean["filter"], dict):
            continue
        if kind == "radio_audio" and clean["state"] not in ("on", "off", "up", "down"):
            continue
        if kind == "transcript" and clean["state"] not in ("show", "hide"):
            continue
        if kind == "radio_scope" and clean["state"] not in ("all", "one"):
            continue
        out.append(clean)
    return out[:4]


def describe_for_prompt() -> str:
    """The action list as the system prompt explains it."""
    return """Actions (return them in `actions`; empty list when the user only asked a question):
- show_list {filter?}: open the plane list, optionally with a new filter
- hide_list: close the list
- set_filter {filter}: narrow the list ("only Southwest above thirty thousand")
- clear_filter: remove all filters
- sort {by: distance|altitude|speed, order?: asc|desc}
- page {direction: next|prev}
- open_plane {query}: open one plane by callsign or tail number
- open_row {n}: open row n of the list page on screen ("open number three")
- close_plane: back from an opened plane to the list
- count {filter}: for "how many ...?" or "any ...?" questions about traffic. The app counts and says the number.
- radar_range {nm}: zoom the radar to that many nautical miles; 0 = automatic
- set_runway {runway: 10|28|18|36|auto}: set the runway in use at Wood County by hand, or "auto" to let the app work it out from the traffic again
- sky_filter {filter?, fromList?}: show only matching planes on the compass bar and in the sky ("only show helicopters in the sky", "just Southwest above thirty thousand in the sky"). fromList true = use the list's current filter. With neither, everything is shown again. This does not open the list
- ar_range {km}: how far out planes are shown on the compass bar and in the sky, in kilometers, 5 to 200; 0 = back to the default of 50. This is not the radar zoom and not a list filter
- connect_feed {feed, scope?}: start playing a radio feed and showing its transcript. `feed` is a feed id from the "Radio" lines of the context, and only one that is live. scope "facility" = every channel of that controller in the transcript, "channel" = only this one
- radio_scope {state: all|one}: while listening to a controller with several channels, show every channel's calls in the transcript, or only the channel that is playing
- disconnect_feed: stop listening to the radio
- radio_audio {state: on|off|up|down}: unmute, mute or change the volume of the radio without disconnecting
- transcript {state: show|hide}: show or hide the radio transcript, independent of the audio

Filter fields (all optional): fleet "bgsu" (BGSU's trainers), kind (jets, props, helicopters, military, medical,
emergencies), airline (ICAO code: Southwest SWA, Delta DAL, American AAL, United UAL, FedEx FDX, UPS UPS,
Spirit NKS, Frontier FFT, JetBlue JBU, SkyWest SKW, Republic RPA, Endeavor EDV, Envoy ENY, PSA JIA,
Allegiant AAY, Air Canada ACA, NetJets EJA), typeCode, minAltFt, maxAltFt, minDistNm, maxDistNm,
climbing, descending, onGround (hide|show|only), query.

For list, count and radar actions keep `answer` to a few words: the app adds the count and the nearest match itself."""
