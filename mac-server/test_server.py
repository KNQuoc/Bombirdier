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
check("runway auto", actions("Set the runway back to automatic"), [{"type": "set_runway", "runway": "auto"}])
check("detect runway", actions("Detect the runway again."), [{"type": "set_runway", "runway": "auto"}])
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
check("context: airport", "Runway in use: 28 (right traffic; set in the app)" in text, True)
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

# --- Radio: "Can I access?", the audio and transcript switches, what was said (radiotalk.py)
import radiotalk  # noqa: E402
from prompt import context_text  # noqa: E402

STATIONS = [
    {"id": "1g0-ctaf", "name": "Wood County CTAF", "feedId": "1g0-ctaf"},
    {"id": "tol-app", "name": "Toledo Approach", "feedId": "tol-app"},
    {"id": "dtw-app", "name": "Detroit Approach", "feedId": "dtw-app-west"},
    {"id": "zob", "name": "Cleveland Center", "feedId": "zob-47"},
    {"id": "nofeed", "name": "Fort Wayne Approach", "feedId": None},
]
FEEDS = [
    {"id": "1g0-ctaf", "name": "Wood County CTAF", "status": "idle"},
    {"id": "tol-app", "name": "Toledo Approach", "status": "online"},
    {"id": "dtw-app-west", "name": "Detroit Approach", "status": "online"},
    {"id": "zob-47", "name": "Cleveland Center", "status": "offline"},
]
TOLEDO = {"id": "tol-app", "name": "Toledo Approach", "freqs": ["126.1", "134.35"], "feedId": "tol-app"}
CTAF = {"id": "1g0-ctaf", "name": "Wood County CTAF", "freqs": ["122.975"], "feedId": "1g0-ctaf"}


def rctx(**more):
    return {"focus": None, "radio": {"connected": None, "audio": True, "transcript": True, "stations": STATIONS}, "feeds": FEEDS, **more}


def on(feed="tol-app", **more):
    return rctx(radio={"connected": feed, "audio": True, "transcript": True, "stations": STATIONS}, **more)


def said(text, ctx):
    r = rules.quick(text, ctx)
    return None if r is None else r["answer"]


CONNECT_TOLEDO = [{"type": "connect_feed", "feed": "tol-app"}]
check("access: looking at a live controller", actions("Can I access?", rctx(station=TOLEDO)), CONNECT_TOLEDO)
check("access: says it's live", said("Can I access?", rctx(station=TOLEDO)), "Yes, Toledo Approach is live. Connecting.")
check("access: controller not playing, nothing connects", actions("can I access", rctx(station=CTAF)), [])
check("access: offers what is live instead", said("can I access", rctx(station=CTAF)), "Wood County CTAF isn't playing on the Mac right now. Toledo Approach is live, say connect to Toledo Approach for that.")
check("access: by name", actions("Connect me to Toledo.", rctx()), CONNECT_TOLEDO)
check("access: by name, other words", actions("listen to Detroit approach", rctx()), [{"type": "connect_feed", "feed": "dtw-app-west"}])
check("access: named one wins over the one in view", actions("tune in to Detroit", rctx(station=TOLEDO)), [{"type": "connect_feed", "feed": "dtw-app-west"}])
check("access: offline by name", actions("connect to Cleveland Center", rctx()), [])
PLANE_ON_TOLEDO = {**SOUTHWEST, "radio": {"facility": "tol-app", "name": "Toledo Approach", "freq": "126.1", "feedId": "tol-app", "heardAgoS": 62}}
check("access: a plane goes to its controller", actions("Can I hear this one?", rctx(focus=PLANE_ON_TOLEDO)), CONNECT_TOLEDO)
check("access: a plane, how sure", said("can I access", rctx(focus=PLANE_ON_TOLEDO)), "It's probably on Toledo Approach, and I heard it there a minute ago. Connecting.")
check("access: plane on a controller with no feed", actions("can I access", rctx(focus={**SOUTHWEST, "radio": {"name": "Fort Wayne Approach", "freq": None, "feedId": None, "heardAgoS": None}})), [])
check("access: nothing in view, two live: asks which", actions("can I access", rctx()), [])
check("access: nothing in view, two live: names them", "Toledo Approach, Detroit Approach" in said("can I access", rctx()), True)
check("access: already on it", said("can I access", on(station=TOLEDO)), "You're already on Toledo Approach.")
check("access: 'show me the list' is not a radio command", actions("show me the list", rctx(station=TOLEDO)), [{"type": "show_list"}])

check("disconnect", actions("Disconnect.", on()), [{"type": "disconnect_feed"}])
check("stop listening", actions("stop listening", on()), [{"type": "disconnect_feed"}])
check("mute", actions("Mute the radio.", on()), [{"type": "radio_audio", "state": "off"}])
check("mute by name", actions("mute Toledo", on()), [{"type": "radio_audio", "state": "off"}])
check("unmute", actions("unmute", on()), [{"type": "radio_audio", "state": "on"}])
check("radio on", actions("Radio on", on()), [{"type": "radio_audio", "state": "on"}])
check("turn it down", actions("turn it down", on()), [{"type": "radio_audio", "state": "down"}])
check("louder", actions("Louder!", on()), [{"type": "radio_audio", "state": "up"}])
check("hide transcript", actions("hide the transcript", on()), [{"type": "transcript", "state": "hide"}])
check("show transcript", actions("show the transcript", on()), [{"type": "transcript", "state": "show"}])
check("transcript only", actions("transcript only", on()), [{"type": "radio_audio", "state": "off"}, {"type": "transcript", "state": "show"}])
check("audio only", actions("audio only", on()), [{"type": "radio_audio", "state": "on"}, {"type": "transcript", "state": "hide"}])
check("mute while not connected does nothing", actions("mute the radio", rctx()), [])
check("mute while not connected says so", said("mute the radio", rctx()).startswith("You're not connected"), True)

RECENT = [
    {"feedId": "tol-app", "agoS": 95, "text": "Delta 1830, descend and maintain 4,000.", "callsignTokens": ["DAL1830"]},
    {"feedId": "tol-app", "agoS": 20, "text": "November 337 Bravo Golf, radar contact.", "callsignTokens": ["N337BG"]},
]
check("what did they say", said("What did they just say?", on(radioRecent=RECENT)), "20 seconds ago: November 337 Bravo Golf, radar contact.")
check("what did they say: nothing", said("what did they say", on(radioRecent=[])), "Nothing has been said on the radio in the last few minutes.")
check("who's on frequency", said("Who's on this frequency?", on(radioRecent=RECENT)), "In the last few minutes I heard Delta 1830 and November 337 Bravo Golf.")
check("what did they tell Delta goes to Aivana", rules.quick("what did they tell Delta", on(radioRecent=RECENT)), None)
check("who is it talking to: heard", said("Who is it talking to?", rctx(focus=PLANE_ON_TOLEDO)), "Toledo Approach on 1 2 6 point 1. I heard it there a minute ago.")
check("who is it talking to: guess", said("what frequency is it on", rctx(focus={**SOUTHWEST, "radio": {"name": "Cleveland Center", "freq": None, "feedId": "zob-47", "heardAgoS": None}})), "Probably Cleveland Center. I haven't heard it on the radio.")
check("who is it talking to: nothing in view", said("who is it talking to", rctx()).startswith("Point at a plane"), True)
check("is Toledo live", said("Is Toledo live?", rctx()), "Yes, Toledo Approach is live.")
check("is Cleveland live", said("is cleveland center up", rctx()), "No, Cleveland Center isn't playing right now.")
check("what's live", said("What's live?", rctx()), "Live right now: Toledo Approach, Detroit Approach.")
check("say_freq", radiotalk.say_freq("134.35"), "1 3 4 point 3 5")
check("ago", [radiotalk.ago(3), radiotalk.ago(42), radiotalk.ago(70), radiotalk.ago(400)], ["5 seconds ago", "40 seconds ago", "a minute ago", "7 minutes ago"])

check("radio actions pass validation", tools.validate_actions([{"type": "connect_feed", "feed": "tol-app"}, {"type": "radio_audio", "state": "off"}, {"type": "transcript", "state": "hide"}, {"type": "disconnect_feed"}]),
      [{"type": "connect_feed", "feed": "tol-app"}, {"type": "radio_audio", "state": "off"}, {"type": "transcript", "state": "hide"}, {"type": "disconnect_feed"}])
check("radio actions: wrong state dropped", tools.validate_actions([{"type": "radio_audio", "state": "show"}, {"type": "transcript", "state": "up"}, {"type": "connect_feed"}]), [])
text = context_text(on(station=TOLEDO, focus=PLANE_ON_TOLEDO, radioRecent=RECENT))
check("context: feeds and which are live", "Toledo Approach (feed id tol-app, live)" in text and "Cleveland Center (feed id zob-47, not playing)" in text, True)
check("context: connected state", "Radio: listening to Toledo Approach, audio on, transcript shown." in text, True)
check("context: recent calls", "20 s ago: November 337 Bravo Golf, radar contact." in text, True)
check("context: plane's controller", "probably talking to Toledo Approach 126.1, heard there 62 s ago" in text, True)

# --- How far out the bar shows planes
check("range: digits", actions("Set the range to 75 kilometers."), [{"type": "ar_range", "km": 75}])
check("range: words", actions("change the range to seventy five"), [{"type": "ar_range", "km": 75}])
check("range: bare", actions("range 100"), [{"type": "ar_range", "km": 100}])
check("range: a hundred", actions("extend the bar range out to a hundred kilometers"), [{"type": "ar_range", "km": 100}])
check("range: miles are nautical", actions("set the range to 40 miles"), [{"type": "ar_range", "km": 74}])
check("range: 150", actions("set the range to 150 km"), [{"type": "ar_range", "km": 150}])
check("range: over the limit is capped", actions("set the range to 300 km"), [{"type": "ar_range", "km": 200}])
check("range: over the limit says so", "most the bar can show is 200" in rules.quick("set the range to 300 km", CTX)["answer"], True)
check("range: number words", [rules._amount(w) for w in ["two hundred", "one hundred fifty", "a hundred and seventy five", "one fifty", "one seventy five", "seventy five", "a hundred", "200", "five hundred", "hundred hundred", "seven seven"]], [200, 150, 175, 150, 175, 75, 100, 200, 500, None, None])
check("range: two hundred", actions("set the range to two hundred kilometers"), [{"type": "ar_range", "km": 200}])
check("range: floor", actions("set the radius to 2"), [{"type": "ar_range", "km": 5}])
check("range: reset", actions("reset the range"), [{"type": "ar_range", "km": 0}])
check("range: back to default", actions("put the range back to default"), [{"type": "ar_range", "km": 0}])
check("range: asking", rules.quick("what's the range", {**CTX, "arRadiusKm": 75})["answer"], "The bar shows planes within 75 kilometers. You can set it anywhere up to 200.")
check("range: not the radar zoom", actions("zoom the radar to 20 miles"), [{"type": "radar_range", "nm": 20}])
check("range: nonsense goes to Aivana", rules.quick("set the range to something bigger", CTX), None)
check("range action passes validation", tools.validate_actions([{"type": "ar_range", "km": 75}]), [{"type": "ar_range", "km": 75}])

# --- Weather here and the forecast (forecast.py), with a made-up forecast: no network
import asyncio  # noqa: E402
import forecast as W  # noqa: E402

NOW = datetime(2026, 11, 21, 9, 0)


def ts(hour, day=21):
    return datetime(2026, 11, day, hour % 24).timestamp() + (86400 if hour >= 24 else 0)


def period(start, end, change=None, **kw):
    base = {"timeFrom": ts(start), "timeTo": ts(end), "timeBec": None, "fcstChange": change, "probability": None, "wdir": None, "wspd": None,
            "wgst": None, "visib": None, "vertVis": None, "wxString": None, "clouds": []}
    return {**base, **kw}


TAF = {
    "icaoId": "KTOL", "name": "Toledo/Express Arpt", "lat": 41.587, "lon": -83.805, "validTimeFrom": ts(6), "validTimeTo": ts(30), "rawTAF": "TAF KTOL ...",
    "fcsts": [
        period(6, 13, wdir="VRB", wspd=3, visib="6+", clouds=[{"cover": "FEW", "base": 25000}]),
        period(13, 20, "FM", wdir=190, wspd=8, visib="6+", clouds=[{"cover": "SCT", "base": 5000}]),
        period(15, 18, "TEMPO", visib=4, wxString="-SHRA", clouds=[{"cover": "BKN", "base": 2500}]),
        period(20, 30, "FM", wdir=220, wspd=12, wgst=22, visib=3, wxString="-RA BR", clouds=[{"cover": "OVC", "base": 900}]),
        period(22, 26, "PROB", probability=30, visib=1, wxString="TSRA"),
    ],
}
check("forecast: category", [W.category(f) for f in TAF["fcsts"]], ["VFR", "VFR", "MVFR", "IFR", "IFR"])
check("forecast: times", [W.hour(ts(13), NOW), W.hour(ts(12), NOW), W.hour(ts(24), NOW), W.hour(ts(30), NOW)], ["1 PM", "noon", "midnight", "tomorrow at 6 AM"])
check("forecast: summary", W.summary(TAF, NOW, 12),
      "Until 1 PM: wind variable at 3 knots, visibility more than 6 miles, a few clouds at 25,000 feet. "
      "From 1 PM: wind from the south at 8 knots, visibility more than 6 miles, scattered clouds at 5,000 feet. "
      "From 8 PM: wind from the southwest at 12 knots, gusting 22, visibility 3 miles, light rain, mist, overcast at 900 feet. Instrument conditions. "
      "At times between 3 PM and 6 PM: light rain showers, visibility 4 miles, broken clouds at 2,500 feet.")
check("forecast: one period", W.summary(TAF, NOW, 3), "Through noon: wind variable at 3 knots, visibility more than 6 miles, a few clouds at 25,000 feet.")


def rain(text, now=NOW):
    start, end, label = W.window(text, now)
    codes, noun = W._asked_for(text)
    return W.precipitation(TAF, now, start, end, label, codes, noun)


check("rain: this morning, none", rain("will it rain this morning"), "No rain in the Toledo forecast this morning.")
check("rain: this afternoon, at times", rain("will it rain this afternoon"), "At times, yes: light rain showers between 3 PM and 6 PM, in the Toledo forecast.")
check("rain: tonight", rain("is it going to rain tonight"), "Yes: light rain, mist from about 8 PM, in the Toledo forecast.")
check("snow: none", rain("will it snow tonight"), "No snow in the Toledo forecast tonight.")
check("storms: a chance", rain("any thunderstorms tonight"), "Maybe: a 30 percent chance of thunderstorms and rain between 10 PM and tomorrow at 2 AM, in the Toledo forecast.")
check("rain: default is the next 12 hours", rain("will it rain"), "At times, yes: light rain showers between 3 PM and 6 PM, in the Toledo forecast.")
check("rain: beyond the forecast", rain("will it rain tomorrow afternoon"), "The Toledo forecast only runs until tomorrow at 6 AM, so I can't say for tomorrow afternoon.")
check("window: this afternoon asked in the evening falls back", W.window("will it rain this afternoon", datetime(2026, 11, 21, 20, 0))[2], "in the next 12 hours")
check("window: next few hours", W.window("any rain in the next few hours", NOW)[2], "in the next 3 hours")


def fly(text):
    start, end, label = W.window(text, NOW)
    return W.flying(TAF, NOW, start, end, label)


check("flying: this morning", fly("will it stay vfr this morning"), "The Toledo forecast is visual conditions this morning. Check the official briefing before you fly.")
check("flying: this afternoon dips", fly("is it going to stay vfr this afternoon"),
      "The Toledo forecast is visual conditions this afternoon, dropping at times between 3 PM and 6 PM: light rain showers, visibility 4 miles, broken clouds at 2,500 feet. Check the official briefing before you fly.")
check("flying: goes down tonight", fly("is the weather going to hold"),
      "Visual conditions until 8 PM, then instrument conditions: light rain, mist, visibility 3 miles, overcast at 900 feet, gusts to 22 knots, in the Toledo forecast. Check the official briefing before you fly.")
check("forecast at a time", W.describe_period(W.at_time(TAF, ts(14))), "wind from the south at 8 knots, visibility more than 6 miles, scattered clouds at 5,000 feet.")

BECOMING = {"name": "Findlay Arpt", "validTimeTo": ts(30), "fcsts": [
    period(6, 30, wdir=270, wspd=10, visib="6+", clouds=[{"cover": "OVC", "base": 4000}]),
    {**period(14, 30, "BECMG", clouds=[{"cover": "SCT", "base": 4000}]), "timeBec": ts(16)},
]}
check("becoming: only what changes, from when it's done", W.summary(BECOMING, NOW, 12),
      "Until 4 PM: wind from the west at 10 knots, visibility more than 6 miles, overcast at 4,000 feet. "
      "From 4 PM: wind from the west at 10 knots, visibility more than 6 miles, scattered clouds at 4,000 feet.")

for text, kind in [
    ("What's the weather?", "here"), ("How's the weather here right now?", "here"), ("What are the winds doing?", "here"), ("What's the ceiling?", "here"),
    ("What's the forecast?", "forecast"), ("What's the forecast for tonight?", "forecast"), ("What's the weather going to be like this afternoon?", "forecast"),
    ("What's the weather like tomorrow?", "forecast"), ("Forecast", "forecast"),
    ("Will it rain?", "precip"), ("Is it going to snow tonight?", "precip"), ("Any rain coming?", "precip"), ("Any storms in the forecast this afternoon?", "precip"),
    ("Will it stay VFR this afternoon?", "flying"), ("Is the weather going to hold?", "flying"), ("Can we fly this afternoon?", "flying"),
    ("What's the weather like when it lands?", "arrival"), ("What's the forecast at its destination?", "arrival"),
    ("What's the weather at its destination?", None), ("When does it land?", None), ("What's that plane?", None), ("Show me the list", None),
]:
    got = W.wants(rules.normalize(text))
    check(f"weather question: {text}", got[0] if got else None, kind)
check("weather at its destination stays a current-report question", F.wants(rules.normalize("What's the weather at its destination?")), "weather_destination")


async def _weather_answers():
    METAR = {"icaoId": "KTDZ", "name": "Toledo/Metcalf Fld", "lat": 41.56, "lon": -83.48, "distanceNm": 12.2, "wdir": 130, "wspd": 3, "visib": 5, "wxString": "BR",
             "clouds": [{"cover": "CLR"}], "temp": 3, "fltCat": "MVFR"}

    async def fake_nearest(kind, lat, lon):
        return {**TAF, "distanceNm": 14.1} if kind == "taf" else METAR

    async def fake_airport(icao):
        return TAF if icao == "KSFO" else None

    W.nearest, W.for_airport = fake_nearest, fake_airport
    check("answer: weather here", await W.answer("here", "whats the weather", {}, now=NOW),
          "The nearest weather station is Toledo, 12 miles away. Toledo right now: wind from the southeast at 3 knots, visibility 5 miles, mist, clear skies, 3 degrees Celsius. Marginal.")
    check("answer: forecast starts with the station", (await W.answer("forecast", "whats the forecast", {}, now=NOW)).startswith("The nearest forecast is Toledo, 14 miles away. Toledo forecast. Until 1 PM: wind variable"), True)
    check("answer: forecast for tonight", (await W.answer("forecast", "whats the forecast for tonight", {}, now=NOW)).startswith("The nearest forecast is Toledo, 14 miles away. Toledo forecast for tonight. Until 8 PM: wind from the south"), True)
    check("answer: rain", await W.answer("precip", "will it rain this afternoon", {}, now=NOW), "At times, yes: light rain showers between 3 PM and 6 PM, in the Toledo forecast.")
    prog = F.progress(AAL, now=datetime(2026, 11, 21, 9, 0))
    prog["eta"] = datetime(2026, 11, 21, 14, 30)
    check("answer: when it lands", await W.answer("arrival", "", {}, AAL, prog, now=NOW),
          "When it gets to San Francisco, around 2:30 PM your time by my estimate, the forecast is: wind from the south at 8 knots, visibility more than 6 miles, scattered clouds at 5,000 feet.")
    check("answer: when it lands, no plane", (await W.answer("arrival", "", {}, None, None, now=NOW)).startswith("I don't see a plane"), True)
    lines = await W.context_lines({}, now=NOW)
    check("context: weather and forecast lines", [l.split(":")[0] for l in lines], ["Weather near the user now (Toledo, 12 miles away)", "Forecast (Toledo, 14 miles away; official airport forecast)"])


asyncio.run(_weather_answers())

# --- When a plane really took off (opensky.py), with made-up tracks: no network
import opensky as O  # noqa: E402

T0 = datetime(2026, 11, 21, 0, 41).timestamp()
LATER = datetime(2026, 11, 21, 2, 20)
# [time, lat, lon, altitude in meters, track, on ground]: off the ground at Charlotte, climbing west.
FROM_CLT = {"callsign": "AAL3035", "startTime": T0, "path": [[T0, 35.22, -80.95, 230, 180, False], [T0 + 600, 35.6, -81.9, 6000, 290, False], [T0 + 3600, 39.0, -84.0, 10600, 300, False]]}
took = O.takeoff(FROM_CLT, p, LATER)
check("takeoff: from the ground at the route's origin", (took["fromGround"], took["atOrigin"], round(took["agoMin"]), round(took["awayFromOriginNm"])), (True, True, 99, 0))
check("takeoff answer", F.answer("departed", AAL, p, {}, took), "It took off from Charlotte at 12:41 AM, 1 hour 40 minutes ago. That's when receivers first saw it leave, not the airline's gate time.")
check("takeoff: the estimate is still the answer without a track", F.answer("departed", AAL, p, {}, None).startswith("Roughly 1 hour ago from Charlotte"), True)

# First seen already at cruise (it flew into coverage): that is not a takeoff.
MIDAIR = {"path": [[T0, 44.0, -60.0, 11000, 250, False], [T0 + 3600, 42.0, -75.0, 11000, 250, False]]}
seen = O.takeoff(MIDAIR, p, LATER)
check("first seen in the air is not a takeoff", seen["fromGround"], False)
check("...so the estimate is used", F.answer("departed", AAL, p, {}, seen).startswith("Roughly 1 hour ago from Charlotte"), True)

# A high airport: starts at 1,700 m without the on-ground flag, then climbs: Denver, not mid-air.
DENVER = {"path": [[T0, 39.85, -104.67, 1700, 80, False], [T0 + 900, 40.2, -103.0, 9000, 80, False]]}
check("high airport counts when it then climbs", O.takeoff(DENVER, None, LATER)["fromGround"], True)
check("low and level from the start, never climbing: still a low start", O.takeoff({"path": [[T0, 41.4, -83.6, 500, 90, False], [T0 + 300, 41.4, -83.5, 520, 90, False]]}, None, LATER)["fromGround"], True)
check("mid-level and level: not a takeoff", O.takeoff({"path": [[T0, 41.4, -83.6, 2000, 90, False], [T0 + 300, 41.4, -83.5, 2050, 90, False]]}, None, LATER)["fromGround"], False)
check("on-ground flag", O.takeoff({"path": [[T0, 39.85, -104.67, None, 80, True]]}, None, LATER)["fromGround"], True)
check("no track", O.takeoff(None, p, LATER), None)
check("empty track", O.takeoff({"path": []}, p, LATER), None)

# Took off somewhere the route doesn't mention: the plane is believed, the route doubted.
FROM_BOSTON = {"path": [[T0, 42.36, -71.0, -300, 315, False], [T0 + 900, 42.5, -72.5, 8000, 280, False]]}
wrong = {**O.takeoff(FROM_BOSTON, p, LATER), "near": "Boston"}
check("takeoff: not at the route's origin", (wrong["fromGround"], wrong["atOrigin"]), (True, False))
check("takeoff answer: route doubted", F.answer("departed", AAL, p, {}, wrong),
      "It took off near Boston at 12:41 AM, 1 hour 40 minutes ago. The route I have says Charlotte, which doesn't match where it left from, so that route may be out of date.")

# No route at all (what Aeromexico 004 looked like): where it came from is still worth saying.
NO_ROUTE = {**AAL, "route": None}
orphan = {**O.takeoff(FROM_BOSTON, None, LATER), "near": "Boston"}
check("no route: when did it take off", F.answer("departed", NO_ROUTE, None, {}, orphan),
      "It took off near Boston at 12:41 AM, 1 hour 40 minutes ago. That's when receivers first saw it leave, not the airline's gate time. I have no route for it, so I don't know where it's headed.")
check("no route: where is it going", F.answer("route", NO_ROUTE, None, {}, orphan),
      "There's no route on file for American 3035, so I don't know where it's going. It took off near Boston at 12:41 AM, 1 hour 40 minutes ago.")
check("no route, no track: as before", F.answer("route", NO_ROUTE, None, {}, None), "I don't know where American 3035 is going: there's no route on file for it, so I can't work that out.")
late = O.takeoff({"path": [[datetime(2026, 11, 20, 22, 15).timestamp(), 35.22, -80.95, 230, 180, False]]}, p, LATER)
check("left before midnight", F.took_off_when(late), "yesterday at 10:15 PM, 4 hours 5 minutes ago")
check("context: actual takeoff, and no guessed departure beside it", [l for l in F.context_lines(AAL, p, {}, took) if "takeoff" in l or "have left" in l],
      ["Actual takeoff (seen by tracking receivers; a real time, not the airline's schedule): from Charlotte at 12:41 AM, 1 hour 40 minutes ago."])
check("context: no route, still the takeoff", F.context_lines(NO_ROUTE, None, {}, orphan), ["Actual takeoff (seen by tracking receivers; a real time, not the airline's schedule): near Boston at 12:41 AM, 1 hour 40 minutes ago."])
check("ids that aren't real addresses are not asked about", [O._hex({"id": "~2a3b4c"}), O._hex({"id": "A32095"}), O._hex({})], [None, "a32095", None])

# --- Only some planes in the sky
HELIS = [{"type": "sky_filter", "filter": {"kind": "helicopters"}}]
check("sky: only show helicopters in the sky", actions("Only show helicopters in the sky."), HELIS)
check("sky: show me just the helicopters in the view", actions("show me just the helicopters in the view"), HELIS)
check("sky: only helicopters", actions("only helicopters"), HELIS)
check("sky: hide everything but", actions("hide everything but the helicopters"), HELIS)
check("sky: BGSU", actions("just the BGSU planes in the sky"), [{"type": "sky_filter", "filter": {"fleet": "bgsu"}}])
check("sky: from the list", actions("apply that filter to the sky"), [{"type": "sky_filter", "fromList": True}])
check("sky: clear", actions("show everything in the sky again"), [{"type": "sky_filter"}])
check("sky: clear, short", actions("clear the sky filter"), [{"type": "sky_filter"}])
check("sky: the list still opens the list", actions("show me the helicopters"), [{"type": "show_list", "filter": {"kind": "helicopters"}}])
check("sky: 'show everything' alone is still the list", actions("show me everything"), [{"type": "clear_filter"}, {"type": "show_list"}])
check("sky: something harder goes to Aivana", rules.quick("only show Southwest above thirty thousand in the sky", CTX), None)
check("sky actions pass validation", tools.validate_actions([{"type": "sky_filter", "filter": {"kind": "jets"}}, {"type": "sky_filter", "fromList": True}, {"type": "sky_filter"}]),
      [{"type": "sky_filter", "filter": {"kind": "jets"}}, {"type": "sky_filter", "fromList": True}, {"type": "sky_filter"}])

print(f"{passed} passed, {failed} failed")
raise SystemExit(1 if failed else 0)
