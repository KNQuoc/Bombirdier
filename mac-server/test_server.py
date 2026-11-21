"""Tests for the parts that need no network and no model: the instant rules, speech text, action checks.

    python3 test_server.py
"""
import rules
import speech
import tools
from prompt import context_text

ARCHER = {
    "id": "a1", "callsign": "N337BG", "registration": "N337BG", "typeCode": "P28A", "typeName": "Piper PA-28 Archer", "tag": "BGSU",
    "altitudeFt": 1712, "verticalRateFpm": 0, "groundSpeedKt": 95, "distanceKm": 1.7, "bearingDeg": 3, "leg": "Right downwind · RWY 28",
}
SOUTHWEST = {
    "id": "a2", "callsign": "SWA1234", "airline": "Southwest Airlines", "typeCode": "B738", "typeName": "Boeing 737-800",
    "origin": "MDW", "destination": "CLE", "altitudeFt": 36000, "verticalRateFpm": -1200, "distanceKm": 55.6, "bearingDeg": 200,
}
CTX = {"focus": ARCHER, "inView": [ARCHER, SOUTHWEST]}
passed = failed = 0


def check(name, actual, expected):
    global passed, failed
    if actual == expected:
        passed += 1
    else:
        failed += 1
        print(f"FAIL {name}\n  got      {actual!r}\n  expected {expected!r}")


def actions(text, ctx=CTX):
    r = rules.quick(text, ctx)
    return None if r is None else r["actions"]


# What Whisper writes varies in case and punctuation; the meaning shouldn't.
check("next", actions("Next page."), [{"type": "page", "direction": "next"}])
check("next bare", actions("next"), [{"type": "page", "direction": "next"}])
check("previous", actions("Previous page"), [{"type": "page", "direction": "prev"}])
check("close list", actions("Close the list."), [{"type": "hide_list"}])
check("show list", actions("Show me the list"), [{"type": "show_list"}])
check("please", actions("Please show the list"), [{"type": "show_list"}])
check("clear", actions("Clear filters."), [{"type": "clear_filter"}, {"type": "show_list"}])
check("show everything", actions("show me all the planes"), [{"type": "clear_filter"}, {"type": "show_list"}])
check("sort", actions("Sort by altitude."), [{"type": "sort", "by": "altitude"}])
check("sort order", actions("sort by speed slowest first"), [{"type": "sort", "by": "speed", "order": "asc"}])
check("open three", actions("Open number three."), [{"type": "open_row", "n": 3}])
check("open 3", actions("open number 3"), [{"type": "open_row", "n": 3}])
check("number five", actions("Number five"), [{"type": "open_row", "n": 5}])
check("open nine is not a row", actions("open number nine"), None)
check("back", actions("Go back."), [{"type": "close_plane"}])
check("radar miles", actions("Zoom the radar out to 100 miles."), [{"type": "radar_range", "nm": 100}])
check("radar km", actions("zoom radar to 50 kilometers"), [{"type": "radar_range", "nm": 27}])
check("radar word", actions("zoom the radar in to ten miles"), [{"type": "radar_range", "nm": 10}])
check("radar auto", actions("Reset the radar"), [{"type": "radar_range", "nm": 0}])
check("runway spoken", actions("We're using runway one zero."), [{"type": "set_runway", "runway": "10"}])
check("runway digits", actions("switch to runway 28"), [{"type": "set_runway", "runway": "28"}])
check("runway active", actions("Runway three six is active"), [{"type": "set_runway", "runway": "36"}])
check("no such runway", actions("switch to runway 27"), None)
check("helicopters", actions("Show me all the helicopters."), [{"type": "show_list", "filter": {"kind": "helicopters"}}])
check("bgsu", actions("Show me the BGSU planes"), [{"type": "show_list", "filter": {"fleet": "bgsu"}}])
check("trainers", actions("where are the trainers"), [{"type": "show_list", "filter": {"fleet": "bgsu"}}])
check("count", actions("How many helicopters are around?"), [{"type": "count", "filter": {"kind": "helicopters"}}])
check("any emergencies", actions("Any emergencies?"), [{"type": "count", "filter": {"kind": "emergencies"}}])
check("any bgsu", actions("Are there any BGSU planes flying?"), [{"type": "count", "filter": {"fleet": "bgsu"}}])
# Anything with more to it than one obvious meaning goes to Aivana.
check("compound filter", actions("Show me all the jets above thirty thousand feet"), None)
check("airline filter", actions("Only Southwest above thirty thousand."), None)
check("open question", actions("How many seats does that plane have?"), None)
check("why", actions("Why is it descending?"), None)
check("empty", actions("   "), None)

what = rules.quick("What's that plane?", CTX)
check("whats that: no actions", what["actions"], [])
check("whats that: text", what["answer"], "That's N 3 3 7 B G, a BGSU Piper PA-28 Archer. It's less than a mile north at 1,700 feet. Right downwind for runway 28.")
check("what am i looking at", rules.quick("what am I looking at", {"focus": SOUTHWEST})["answer"],
      "That's Southwest 1234, a Boeing 737-800, from MDW to CLE. It's 30 miles south at 36,000 feet, descending.")
check("nothing in view", rules.quick("What is that?", {})["answer"].startswith("I don't see a plane"), True)

check("miles small", speech.miles(1.0), "less than a mile")
check("miles one", speech.miles(1.852), "1 mile")
check("miles mid", speech.miles(9.3), "5 miles")
check("miles frac", speech.miles(4.6), "2.5 miles")
check("compass", [speech.compass_word(b) for b in (0, 44, 46, 200, 359)], ["north", "northeast", "northeast", "south", "north"])
check("helicopter", speech.describe({"callsign": "LIFE5", "kind": "helicopter", "medical": True, "altitudeFt": 1500, "distanceKm": 20, "bearingDeg": 90}),
      "That's L I F E 5, a medical helicopter. It's 11 miles east at 1,500 feet.")

check("valid actions kept", tools.validate_actions([
    {"type": "set_filter", "filter": {"kind": "jets", "minAltFt": 30000}, "by": None, "nm": None},
    {"type": "sort", "by": "altitude", "order": "desc", "query": "junk"},
]), [{"type": "set_filter", "filter": {"kind": "jets", "minAltFt": 30000}}, {"type": "sort", "by": "altitude", "order": "desc"}])
check("bad actions dropped", tools.validate_actions([
    {"type": "launch_missiles"}, {"type": "set_filter"}, {"type": "open_row"}, "nonsense", {"type": "page", "direction": None},
    {"type": "set_filter", "filter": "jets"},
]), [])
check("not a list", tools.validate_actions({"type": "hide_list"}), [])
check("at most four", len(tools.validate_actions([{"type": "hide_list"}] * 9)), 4)

text = context_text({**CTX, "airport": {"ident": "1G0", "name": "Wood County Regional", "activeRunway": "28", "patternSide": "right", "tpaFtMsl": 1700, "elevationFt": 673, "distanceKm": 0.3},
                     "bgsu": [ARCHER], "traffic": {"total": 358, "radiusNm": 250}, "list": {"open": False}})
check("context: airport", "Runway in use: 28 (right traffic)" in text, True)
check("context: focus", "Looking at: N337BG, BGSU, Piper PA-28 Archer, 1,700 feet, 95 knots, less than a mile north, Right downwind · RWY 28" in text, True)
check("context: others exclude the focus", "Also in view: SWA1234, Boeing 737-800, Southwest Airlines, MDW to CLE, 36,000 feet descending, 30 miles south" in text, True)
check("context: empty is fine", context_text({}).startswith("Looking at: no plane"), True)

print(f"{passed} passed, {failed} failed")
raise SystemExit(1 if failed else 0)
