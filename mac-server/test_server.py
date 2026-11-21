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
check("whats that: text", what["answer"], "That's N 3 3 7 B G, a BGSU Piper PA-28 Archer. It's less than a mile north at 1,700 feet. It's on right downwind for runway 2 8.")
check("what am i looking at", rules.quick("what am I looking at", {"focus": SOUTHWEST})["answer"],
      "That's Southwest 1234, a Boeing 737-800, from MDW to CLE. It's 30 miles south at 36,000 feet, descending.")
check("nothing in view", rules.quick("What is that?", {})["answer"].startswith("I don't see a plane"), True)

check("leg final", speech.spoken_leg("Final · RWY 28"), "It's on final for runway 2 8.")
check("leg entry", speech.spoken_leg("Entering the pattern · RWY 10"), "It's entering the pattern for runway 1 0.")
check("leg departure", speech.spoken_leg("Departing · RWY 36"), "It's departing runway 3 6.")
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

# ---- flight progress, arrival estimates, weather wording ----
import flightinfo as F
from datetime import datetime

CLT = {"code": "CLT", "icao": "KCLT", "name": "Charlotte Douglas International Airport", "city": "Charlotte", "lat": 35.214, "lon": -80.9431}
SFO = {"code": "SFO", "icao": "KSFO", "name": "San Francisco International Airport", "city": "San Francisco", "lat": 37.6188, "lon": -122.375}
# Over north-west Ohio, westbound: about where American 3035 was when Kien asked about it.
AAL = {"id": "acda02", "callsign": "AAL3035", "airline": "American Airlines", "typeName": "Airbus A321", "lat": 41.289, "lon": -83.517,
       "groundSpeedKt": 482, "altitudeFt": 35000, "route": {"origin": CLT, "destination": SFO}}
noon = datetime(2026, 11, 21, 12, 0)
p = F.progress(AAL, noon)
check("great circle CLT-SFO", round(F.distance_nm(CLT["lat"], CLT["lon"], SFO["lat"], SFO["lon"])), 1991)
check("flown", round(p["flownNm"]), 384)
check("remaining", round(p["remainingNm"]), 1800)
check("eta minutes = distance / speed + approach", round(p["etaMin"]), round(p["remainingNm"] / 482 * 60 + 6))
check("eta clock", F.spoken_clock(p["eta"]), "3:50 PM")
check("left about an hour ago (cruising: its own speed)", round(p["sinceDepartureMin"]), 61)
# The same plane slowed to 180 kt on approach: its average since takeoff was nowhere near that slow.
check("slow on approach: a jet's typical average is used", round(F.progress({**AAL, "groundSpeedKt": 180, "engine": "jet"}, noon)["sinceDepartureMin"]), round(384 / 380 * 60 + 8))
check("no route, no progress", F.progress({**AAL, "route": None}), None)
check("on the ground: no eta", F.progress({**AAL, "onGround": True})["etaMin"], None)
check("too slow: no eta", F.progress({**AAL, "groundSpeedKt": 12})["etaMin"], None)
check("durations", [F.spoken_duration(m) for m in (0.4, 1, 47, 60, 228, 122)], ["1 minute", "1 minute", "47 minutes", "1 hour", "3 hours 50 minutes", "2 hours"])
check("miles", [F.miles(n) for n in (1, 37.4, 384, 1800)], ["1 mile", "37 miles", "380 miles", "1,800 miles"])

for said, kind in [
    ("How long is it until it reaches San Francisco?", "eta"),  # what Kien actually asked
    ("When does it land?", "eta"), ("What time will that plane arrive?", "eta"), ("What's its ETA?", "eta"), ("How much longer until it gets there", "eta"),
    ("How far has it flown?", "distance"), ("How far does it have to go?", "distance"), ("How many miles left?", "distance"),
    ("When did it take off?", "departed"), ("How long has it been flying?", "departed"),
    ("Where is it going?", "route"), ("Where did that plane come from?", "route"), ("Where's it headed?", "route"),
    ("What's the weather at its destination?", "weather_destination"), ("How's the weather where it's going?", "weather_destination"),
    ("What's the weather like when it lands?", "weather_destination"),
    ("What's the weather where it is right now?", "weather_below"), ("How is the weather along the way?", "weather_below"),
    ("What was the weather where it came from?", "weather_origin"),
    ("How many seats does it have?", None), ("When was the A321 first built?", None), ("What's the weather in Paris?", None), ("Next page", None),
]:
    check(f"wants: {said}", F.wants(rules.normalize(said)), kind)

check("eta answer", F.answer("eta", AAL, p, {}),
      "About 3 hours 50 minutes, around 3:50 PM your time. That's my estimate from 1,800 miles to San Francisco at 482 knots, not the airline's time.")
check("distance answer", F.answer("distance", AAL, p, {}), "It has flown about 380 miles from Charlotte and has 1,800 miles to go to San Francisco.")
check("route answer", F.answer("route", AAL, p, {}), "American 3035 is flying from Charlotte to San Francisco, 1,800 miles to go.")
check("departed answer", F.answer("departed", AAL, p, {}).startswith("Roughly 1 hour ago from Charlotte, judging by the 380 miles it has covered."), True)
check("no route answer", F.answer("eta", {**AAL, "route": None}, None, {}), "I don't know where American 3035 is going: there's no route on file for it, so I can't work that out.")
check("nothing in view", F.answer("eta", None, None, {}).startswith("I don't see a plane"), True)

KSFO = {"icaoId": "KSFO", "temp": 10.6, "wdir": 290, "wspd": 3, "wgst": None, "visib": "10+", "fltCat": "VFR", "clouds": [{"cover": "FEW", "base": 2500}], "wxString": None, "name": "San Francisco Intl, CA, US", "rawOb": "METAR KSFO 210456Z 29003KT 10SM FEW025 11/07 A3013"}
check("metar: fair", F.describe_metar(KSFO), "wind from the west at 3 knots, visibility more than 10 miles, a few clouds at 2,500 feet, 11 degrees Celsius. Good flying weather.")
check("metar: calm and clear", F.describe_metar({"wdir": 0, "wspd": 0, "visib": "10+", "clouds": [], "temp": 3.3, "fltCat": "VFR"}),
      "wind calm, visibility more than 10 miles, clear skies, 3 degrees Celsius. Good flying weather.")
check("metar: low and wet", F.describe_metar({"wdir": "VRB", "wspd": 6, "wgst": 18, "visib": 1.5, "wxString": "-RA BR", "temp": 7, "fltCat": "IFR",
                                               "clouds": [{"cover": "SCT", "base": 400}, {"cover": "OVC", "base": 800}]}),
      "wind variable at 6 knots, gusting 18, visibility 1.5 miles, light rain, mist, overcast at 800 feet, 7 degrees Celsius. Instrument conditions.")
check("weather answer", F.answer("weather_destination", AAL, p, {"destination": KSFO}).startswith("San Francisco right now: wind from the west at 3 knots"), True)
check("weather missing", F.answer("weather_destination", AAL, p, {}), "I couldn't get a weather report for San Francisco just now.")
check("station name", [F.station_name({"name": n}) for n in ("Findlay Arpt, OH, US", "San Francisco Intl, CA, US", "Toledo/Express Arpt, OH, US")], ["Findlay", "San Francisco", "Toledo"])
lines = F.context_lines(AAL, p, {"destination": KSFO})
check("context: progress line", "380 miles flown from Charlotte (CLT), 1,800 miles to go to San Francisco (SFO), 18% of the way" in lines[0], True)
check("context: says estimates", "say these are estimates" in lines[1], True)
check("context: weather line", lines[2].startswith("Weather now at San Francisco: wind from the west"), True)
check("opened plane is the subject when nothing is in view", F.subject({"focus": None, "opened": AAL})["callsign"], "AAL3035")

print(f"{passed} passed, {failed} failed")
raise SystemExit(1 if failed else 0)
