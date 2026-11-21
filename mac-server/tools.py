"""What the assistant can do besides talk: actions the phone carries out.

The server only decides *which* action; the phone owns the list, the radar and the settings, applies
the action, and (for list actions) says how many planes matched, since only it has all the traffic.

Aivana's strict JSON Schema has no oneOf/anyOf, so an action is one flat object: `type` plus whichever
of the optional fields that type uses. validate_actions() checks the combination.

Phase 5 adds the radio tools (connect_feed, radio_audio, transcript, ...) to this file.
"""

LIST_KINDS = ["jets", "props", "helicopters", "military", "medical", "emergencies"]
SORT_KEYS = ["distance", "altitude", "speed"]
RUNWAYS = ["10", "28", "18", "36"]

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
        "runway": {"type": "string", "enum": RUNWAYS},
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
_OPTIONAL = {"show_list": ["filter"], "sort": ["order"]}


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
- set_runway {runway: 10|28|18|36}: change the runway in use at Wood County

Filter fields (all optional): fleet "bgsu" (BGSU's trainers), kind (jets, props, helicopters, military, medical,
emergencies), airline (ICAO code: Southwest SWA, Delta DAL, American AAL, United UAL, FedEx FDX, UPS UPS,
Spirit NKS, Frontier FFT, JetBlue JBU, SkyWest SKW, Republic RPA, Endeavor EDV, Envoy ENY, PSA JIA,
Allegiant AAY, Air Canada ACA, NetJets EJA), typeCode, minAltFt, maxAltFt, minDistNm, maxDistNm,
climbing, descending, onGround (hide|show|only), query.

For list, count and radar actions keep `answer` to a few words: the app adds the count and the nearest match itself."""
