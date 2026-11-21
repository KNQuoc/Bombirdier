# Bombirdier progress

Full plan: [docs/bombirdier-plan.md](docs/bombirdier-plan.md). Each phase also has a GitHub milestone and a tracking issue; tick boxes here as work lands and close the issue when the phase's "Done when" is met.

Legend: ⬜ not started · 🟡 in progress · ✅ done

| Phase | Status | Tracking issue |
|---|---|---|
| 0. Sky-placement patch + rename | 🟡 | [#1](https://github.com/KNQuoc/Bombirdier/issues/1) |
| 1. Live traffic to 250 nm + list view | 🟡 | [#2](https://github.com/KNQuoc/Bombirdier/issues/2) |
| 2. Traffic-pattern overlay at 1G0 | 🟡 | [#3](https://github.com/KNQuoc/Bombirdier/issues/3) |
| 3. AI voice assistant (Mac server + Aivana) | 🟡 | [#4](https://github.com/KNQuoc/Bombirdier/issues/4) |
| 4. Radio-call linking (LiveATC) | 🟡 | [#5](https://github.com/KNQuoc/Bombirdier/issues/5) |
| 5. Controllers on headband + "Can I access?" | 🟡 | [#6](https://github.com/KNQuoc/Bombirdier/issues/6) |
| 6. Stretch goals | 🟡 | [#7](https://github.com/KNQuoc/Bombirdier/issues/7) |

---

## Phase 0: sky-placement patch + rename

- [x] `git apply sky-placement.patch` (applied clean, 8 files)
- [x] Checks pass (`app/android`: `npx tsc -p . && npm run check`; `web`: `npx tsc -p .`)
- [x] `appName` → **Bombirdier** in `capacitor.config.ts`, `npm run sync` (leave `appId` alone). Also `strings.xml` (the launcher name comes from there, `cap sync` does not rewrite it), the page title and the permission messages
- [x] Desktop dev check: bracket lands on a live plane at its elevation, card follows it
- [x] APK builds (`npm run apk` → `app-debug.apk`, 4.8 MB, labeled "Bombirdier (debug)")
- [ ] Outdoors: brackets land on real planes

## Phase 1: live traffic to 250 nm + list view

- [x] `src/traffic/`: near feed (AR radius, 5–30 s) + wide feed (250 nm, ~60 s) that waits while the near feed is throttled, merged by id
- [ ] Measure 250 nm response size in daytime (at 22:30 local: 457 aircraft, 235 kB of JSON, 44 kB gzipped; the info line shows the live figure)
- [x] Settings: AR radius (km, default 50, max 100); Wide traffic on / Wi-Fi only / off
- [x] Route lookups only for near planes + opened planes (verified: 3 requests with 372 planes loaded)
- [x] Route lookup moved to adsb.lol's per-callsign route files: both batch endpoints the hackathon code used are dead (one answers empty, one 403s)
- [x] `src/list/`: panel on both eyes, header, 8 rows/page, status colors; planes below the horizon are dimmed (the words "below horizon" are in the opened view: a row is too narrow for them)
- [x] `ListFilter` model (kind, airline, typeCode, alt/dist ranges, climbing/descending, onGround, query, sort, page) with `sanitizeFilter` for voice input
- [x] Opening a plane: full card with route, pulsing bracket + compass arrow if near, distance + direction + horizon if far
- [x] ☰ button next to ⚙; tap a row, ▲▼ or swipe to page
- [x] Dev keys: `L`, `PageUp`/`PageDown`, `F` (plus `1`–`8` open row, `Esc` back, `R` radar range), and `?dev=1&at=lat,lon` for a fixed position
- [x] Radar ranges up to 463 km; radar follows the filtered list; optional `HudState.radarRangeKm`
- [x] `npm test`: 13 unit tests for filters, sorting, jet/prop classification, BGSU matching, plane lookup, route plausibility
- [x] BGSU home fleet (added at Kien's request, not in the original plan): `BGSU` tag on the card and in the list, orange icon/bracket/radar dot, `fleet: 'bgsu'` list filter (includes planes on the ground). Seen live: N337BG (Archer) and N442BG (Seminole)
- [ ] Confirm the BGSU fleet's tail numbers with Kien (matching is by N<digits>BG + propeller type for now)
- [ ] Daytime check that adsb.lol sees BGSU planes low in the pattern and on the ground at 1G0
- [ ] Done: hundreds of planes in the list in daytime, AR still ≤ 50 km, route service only for near/opened planes (all seen on desktop at night with 372 planes; not yet tried on the phone or in daytime)

## Phase 2: traffic-pattern overlay at Wood County (1G0)

- [x] `src/airports/1g0.ts`: runways, pattern sides, TPA, elevation. Checked against FAA data effective 29 Oct 2026 (via AirNav): 10 left / 28 right / 18 left / 36 right, TPA 1,700 ft MSL, calm-wind runway 28 all confirmed; thresholds use the FAA coordinates
- [x] Active runway setting. Default is now **Auto**: the runway in use is worked out from the traffic (a plane on final or climbing out decides it; a plane level on a downwind suggests it earlier), starting from 28. A runway can still be forced by hand or by voice
- [x] `src/pattern/geometry.ts`: pattern legs as lines (0.75 nm offset and extensions; level at TPA, then 800 ft AGL turning base, 500 ft turning final)
- [x] `src/pattern/classify.ts` with hysteresis (a new leg has to win 2 checks, 2 s apart) + unit tests (one plane per leg, exclusions, runway 10 mirror, tracker)
- [x] Radar: runways, dashed pattern, leg labels (DW, B, F, UW, XW); near the field it zooms to 5 km so the pattern is visible, with faint rim dots for traffic beyond
- [x] Card: "Right downwind · RWY 28" (also in a plane opened from the list)
- [x] Stretch: pattern drawn in the sky as a dashed line
- [x] Fallback viewer altitude corrected to an ellipsoid height (171 m, was 205 m MSL), so near objects like the pattern sit at the right angle before GPS altitude arrives
- [x] From the first live landing (N442BG, runway 18, 2026-11-21; see `docs/recordings/`), all three fixed: the runway in use is detected from traffic; the 45° entry rule no longer fires during a wide base turn; the age of each position (`seen_pos`) is counted, so a plane lost near the ground is no longer flown on from the same old report, and altitude is carried forward 20 s at most
- [x] That landing is now a regression test: replayed in Auto from the default of 28, the app settles on runway 18 within 20 s and shows downwind → base → final
- [ ] See the fixes work on the next live pattern traffic (the replay proves the logic; it has not been watched live since)
- [ ] Tune the classifier's numbers on more live pattern traffic (one landing so far)
- [ ] Done: BGSU planes in the circuit get the right leg most of the time (needs a flying day at the field)

## Phase 3: AI voice assistant

- [x] `mac-server/` FastAPI on :8787, `/api/health`, `/api/voice/ask`, `/api/voice/speak`
- [x] mlx-whisper (`whisper-large-v3-turbo`) with aviation + callsign `initial_prompt`; silence and noise rejected (about 0.3 s per question on this Mac)
- [x] `docs/aivana.md`: written from Aivana's public docs. Not OpenAI-compatible, no tool calling; actions come back through its strict JSON Schema output
- [x] Aivana key in `mac-server/.env` (Kien), `mac-server/llm.py` against `POST /v1/generate`. Measured 3–6 s per call at `effort: low`
- [x] Because of that: `rules.py` answers paging, simple filters, sorting, radar zoom, runway changes and "what's that plane?" on the Mac at once; only open questions go to Aivana
- [x] Assistant prompt (co-pilot, short answers), `mac-server/tools.py` action schema, `{ answer, actions }` reply
- [x] Natural voice: Kokoro on the Mac (asked for by Kien), 0.1–0.6 s per answer, Android TTS as fallback
- [x] Phone: `rollDeg` in orientation, head-tilt push-to-talk, MediaRecorder, `RECORD_AUDIO`
- [x] Phone: context payload, apply actions (and word counts itself), speech playback, `HudState.voice` back on
- [x] USB (`adb reverse`) + Wi-Fi Server URL with cleartext config; Wi-Fi needs a shared token (`BOMBIRDIER_TOKEN`)
- [x] Server access checks after a security review: Host validation, body size cap, token for non-local requests; server text escaped on the phone
- [x] Tests: `mac-server/test_server.py` (55 checks); 12 real audio questions transcribed and answered correctly on the Mac (test voices, not a person)
- [x] On the phone (Pixel 7, 2026-11-21): recording, the Mac link over USB, actions and speech playback work; Kien's spoken question was transcribed correctly. First attempt failed: the speech-level threshold was tuned on a laptop and the phone's mic read far quieter (fixed: threshold follows the background)
- [x] Two-finger tap = talk (phone in hand); `run.sh` keeps `adb reverse` alive (Android drops it on every USB reconnect)
- [x] Flight questions (asked for by Kien after "I don't have the estimated time of arrival"): distance flown and to go, estimated arrival, estimated time since departure, and live weather at the origin, the destination and under the plane (`mac-server/flightinfo.py`). Answered on the Mac in under a second
- [x] Real takeoff times: from the OpenSky Network's track of the flight (`mac-server/opensky.py`), when it tracked the plane from the ground
- [x] Weather where you are and official airport forecasts (`mac-server/forecast.py`); range of the bar by voice, up to 200 km
- [ ] Airline schedule times (scheduled departure and arrival): no free source. adsb.lol has none, its flight-history pages refuse programs, and Aivana's web search got live flights wrong. Needs a flight-status API key if Kien wants them
- [x] Where a plane with no route left from (asked for by Kien, 2026-11-21: small planes file no flight plan). The app remembers the airfield each plane was last stopped on and puts "From Wood County · 25 min ago" on its card; "Seen leaving …" for a touch-and-go; for a plane it never saw on the ground the Mac reads the start of OpenSky's track. Airfields are named from OurAirports' list. "Where did it come from?" by voice
- [ ] Departure line on the phone: built and checked in the desktop preview on live traffic; not yet seen on the phone
- [x] Head-tilt trigger: works (Kien, 2026-11-21)
- [x] Voice chosen by Kien: `af_heart` (US female), which is the default
- [ ] Done: "what's that plane?" answered in < ~3 s (0.8 s on the Mac with test audio; phone not measured); "show me all the jets above thirty thousand feet" opens the filtered list (works, about 3–6 s through Aivana)
- [x] Aivana failures are spoken with their real cause; "what can I say?" help command (2026-11-21)

## Phase 4: radio-call linking (LiveATC)

- [x] How the audio gets in (Kien's decision, 2026-11-21): **through a browser tab**. LiveATC only offers an in-browser player now and says streams may not be used in third-party products, so the server never connects to its streams. The feed plays in LiveATC's player in a Chrome tab; `http://localhost:8787/capture` shares that tab's sound with the server (`"kind": "tab"` in `feeds.json`, `POST /api/feeds/{id}/audio`)
- [x] `mac-server/feeds.json`: five feeds, each with its LiveATC page and name there (checked 2026-11-21): **Wood County CTAF** 122.975 (the one that matters most: BGSU pattern calls; the plan assumed LiveATC didn't cover it), **Toledo Tower and Approach** (one feed mixing 118.1, 126.1, 134.35, Ground and Clearance), **Detroit Approach (Arrival West)** 124.05, **Cleveland Center (Bluffton High)** 119.325, **Columbus Approach (North)** 125.95. The Detroit and Cleveland sectors are a guess from their names. Fort Wayne not looked up (LiveATC refused the lookup)
- [x] Phone follows every feed at once: all calls from the home frequency (first in `feeds.json`), and from the others only calls that name a plane the app knows
- [x] First real capture (2026-11-21): five LiveATC tabs, first through Chrome's tab sharing, then through the capture extension (`mac-server/capture-extension/`, no sharing bars)
- [x] A written record of calls with a summary (`radiolog.py`, `RADIO_LOG=on`); 16 feeds captured through the extension
- [ ] See whether capture keeps going for hours with the tabs in the background: the overnight log of 2026-11-21 will show it (status lines every five minutes)
- [x] Feed worker: ffmpeg decode → call splitting (`splitter.py`) → Whisper with a radio prompt → parse → ring buffer of 200; one connection per feed, started by the phone asking for calls, stopped 2 min after it last asked, reconnect at most every 30 s
- [x] Feed health: `GET /api/feeds`, `POST /api/feeds/{id}/check`
- [x] `POST /api/radio/context` (callsigns around, said the radio way, go into Whisper's prompt)
- [x] `mac-server/radio_parse.py`: phonetics, numbers, GA tails, airline radio names, position reports
- [x] `GET /api/radio/events`, `GET /api/radio/heard`
- [x] Phone (`src/radio/`): polling, matching (exact + tail suffix, near + wide traffic), pulsing highlight for 8 s + subtitle; where the plane is if it's outside the AR view; a leg said on the radio shown next to the classifier's on the card
- [x] Setting: Radio calls On / Off
- [x] Tests: 48 checks on the parser and splitter, a plane-matching test, and the whole pipeline run on test recordings (clean and radio-quality) including one that named real planes in the air: both were matched, one of them 116 km away
- [x] Heard on real ATC audio (2026-11-21, five captured LiveATC tabs): callsigns come out right, other words are rougher
- [x] Prompt reworked for real audio: vocabulary per kind of feed (`"talk"` in `feeds.json`), no example calls, per-feed callsign hints from the phone
- [ ] Still rough on real audio: check the new prompt on a busy hour, and long calls where two transmissions run together
- [ ] Done: Toledo Approach calls appear within a few seconds and mostly match the right plane (needs a real capture)

## Phase 5: controllers on headband + "Can I access?"

- [x] `src/atc/facilities.ts`: Wood County CTAF, Toledo Approach, Detroit Approach, Cleveland Center, Columbus Approach (each has a feed now, so all five are in)
- [x] `src/atc/whoControls.ts`: "likely" guess from position and altitude; a call actually heard on a feed replaces the guess ("✅ heard 40s ago")
- [x] Controller icons on the compass bar with status dots (green live, yellow connecting, red stopped, grey nothing to hear). Status comes with every events poll, twice a second, so the separate per-icon `check` call the plan describes isn't needed
- [x] Focus on controllers (they count as sitting on the horizon); controller card; plane card radio line
- [x] Voice: "Can I access?" for a controller, a plane or by name; disconnect; who is it talking to; what did they just say; who's on frequency; what's live. All answered by rules on the Mac in about 0.1 s (`mac-server/radiotalk.py`); anything else about the radio goes to Aivana with the recent calls as context
- [x] `GET /api/feeds/{id}/audio` MP3 stream (one-time ticket for Wi-Fi); audio element on the phone; the radio goes silent while the assistant listens and low while it talks
- [x] Connected view: LIVE pill, 🔇/💬 icons, last four calls scrolling where the radar is
- [x] Separate audio/transcript switches, remembered per feed for the session
- [x] Done on the Pixel: connecting plays the feed in 0.5 s (audible, confirmed by Kien); mute, unmute, hide transcript, louder and disconnect work
- [ ] Looking at a controller icon in the headset to focus it: not tried
- [x] One icon per controller with its frequencies as channels (Detroit, Cleveland Center, Columbus); combined or single-channel transcript; channel picked by voice
- [ ] Combined transcript with two or more of a controller's channels live at once: not yet seen live
- [ ] Sector guesses for Detroit and Cleveland Center are from sector names; check against what is actually heard
- [x] Airspace view: planes coloured by controller, legend, handoffs parsed from the radio (2026-11-21; on the phone, all guesses so far)
- [ ] See a plane change colour on a handoff while it is in view, and check the handoff parser on a busy hour of real calls

## Phase 6: stretch goals

- [ ] RTL-SDR feed for Wood County CTAF (122.975). Needs a dongle. Less pressing than the plan thought: LiveATC does carry Wood County's CTAF, and it is the first feed in `feeds.json`
- [x] List filters applied to the sky view: "only show helicopters in the sky", "apply that filter to the sky", "show everything in the sky again" (`src/sky-filter.ts`). A marker on the HUD says when one is on, and it is not kept across restarts
- [ ] X-Plane mode: skipped for now (Kien, 2026-11-21)
- [x] Auto active runway: from the traffic (done in Phase 2: `pattern/runway.ts`), and now from the wind when no traffic has shown it (`pattern/wind.ts`: the nearest weather report through the Mac, asked every ten minutes; under 4 knots or variable = the calm-wind runway)
- [x] Pattern in the sky (done in Phase 2)
- [ ] Sky filter and wind runway on the phone: built and checked in the desktop preview on live data; not yet tried on the phone

---

## Log

Newest first. One line per meaningful change: date, phase, what landed.

- 2026-11-21 · phase 5 · **The airspace view: planes coloured by controller, and handoffs.** The project is now aimed at people learning air traffic control (Kien), and how the sky is divided is the hardest thing to picture. "Show me the airspace" (or `K` in dev mode) colours every plane in view by who is working it: Cleveland Center blue, Detroit pink, Toledo teal, Columbus coral, Wood County white (no tower: pilots talk to each other), anyone else grey. Bright = the callsign or a handoff was heard on the radio; faint = a guess from position and altitude. A legend at the lower right counts planes per controller and shows the last handoff heard. New in the radio parser: "contact Detroit Approach one two four point zero five" is a handoff (`radio_parse.handoff()`), and the phone moves the plane to the controller it was sent to (by frequency, by name, or the same airport for "contact tower"); the plane's card gets "⇄ Detroit Arrival East → Tower 118.4 · 12s ago". No boundary lines are drawn: the app has no real sector shapes. Seen on the phone: 15 planes sorted between Toledo, Cleveland Center and Wood County, and a live handoff caught ("RPA5669 → Cleveland Center 119.87"). Not yet seen: a plane changing colour on a handoff while in view, and a "heard" (bright) plane. Tests: app 55, server 399, radio 68.
- 2026-11-21 · phase 3 · **Weather at a named airport.** On the phone "tell me the weather condition at Detroit Metro right now" went to Aivana, which answered "I don't have the current weather conditions": only the weather where you are and at a plane's destination were handled. `airports.find()` now works out which public airport a spoken name means ("detroit metro", "toledo", "findlay", "dtw"; bigger and nearer airports first, US and Canada), `forecast.wants_at()` recognises the existing weather questions with a place in them (current weather, forecast, rain, staying VFR), and `forecast.answer(..., spot=)` reads the report nearest that airport. Other wordings ("is it windy in Fort Wayne?") still go to Aivana, which now gets that airport's report and forecast as context (`forecast.mentioned()`). Also accepted: "tell me / give me / can you tell me" lead-ins and "weather conditions". Checked on live reports by text for Detroit, Cleveland, Columbus, Chicago, Findlay and Fort Wayne; not yet by voice on the phone. Server tests 384 pass.
- 2026-11-21 · phase 3 · **Aivana failures say why, and "what can I say?".** When Aivana gave no answer the assistant said "I can't reach Aivana right now" whatever the cause, or silently described the plane instead. `speech.aivana_trouble()` now words each cause truthfully (no key, out of credit, spending limit, busy, key refused, took too long, unreachable), a 20 s timeout is no longer retried, and a reply with no answer and no valid action counts as a failure instead of silence. New rule: "help" / "what can I say?" lists a few things to try, and the on-screen talk hint points at it. Main README rewritten: who it is for, how to run it (with a no-phone desktop path), a five-minute walkthrough, how Aivana is used, known limits. Server tests 347 pass. Not live yet: needs a server restart and an app reinstall.
- 2026-11-21 · phase 1 · **Wi-Fi sign-in pages are named.** On BGSU-Guest the sky went empty and the app said "rate limited": the network's login page was answering for adsb.lol and adsb.fi (certificate for `securelogin.hpe.com`). `flights/adsb.ts` now checks for a sign-in page when both sources fail (`'sign-in'` problem), the wide feed reports the near feed's real reason instead of always "rate limited", and an empty bar leads with "No plane data: …". Planes load on eduroam; the new message itself has not been seen on a sign-in network yet.
- 2026-11-21 · phase 3 · **Where small planes left from.** `app/android/src/departures/` watches every known plane for stopping on an airfield and leaving it; `airports/lookup.ts` and `mac-server/airports.py` name the airfield (26,397 US and Canada fields from OurAirports, public domain; a 350 nm regional copy in the app). Card line for planes with no route: "From …", "From near …" (OpenSky's track starts close by), "Seen leaving …" (touch-and-go or first seen climbing out: where it was, not where it started). `GET /api/flights/origin` for the plane being looked at; voice answers use the same fact, and "where did it come from?" has its own answer. Live check in the desktop preview, Saturday 10 AM: five BGSU planes up; N347BG's track starts on Wood County 56 minutes earlier; a Citabria over Toledo read "From near Fremont · 9 min ago"; a plane first seen climbing out of Marion turned out to have started at Delaware, which is why a touch-and-go is not called "From". 40 app tests, 330 server checks. Phone was locked: not seen there yet.
- 2026-11-21 · phase 4 · **Radio log, started 03:45** (asked for by Kien, to see in the morning how much was said overnight). `RADIO_LOG=on`: every call goes into `mac-server/logs/radio-YYYY-MM-DD.jsonl` (text only), plus each feed's status every five minutes. Summary by endpoint and by voice: calls, conversations, busiest controller and channel; a call transmitted on two channels at once is counted once. The server now keeps the Mac awake. All 16 feeds captured; in a seven-minute watch five channels produced 22 calls (a medevac flight worked by Detroit and Columbus), so the channels that had only shown silence do pick up audio.
- 2026-11-21 · phase 5 · One controller, several channels (asked for by Kien: "jam all of Detroit within one controller icon", and the same for Columbus and Cleveland). Feeds are grouped under their controller in `feeds.json`; 16 feeds now: Detroit Metro 5 (Arrival West and East, Departure East and West, Tower), Cleveland Center 5 sectors, Columbus 4, Toledo 1, Wood County 1. One icon each, the card lists the channels, "Can I access?" plays one and shows all of them in one transcript, and a channel can be picked or switched by voice. Checked in the desktop preview on the live feeds (one channel live per controller, so the combined transcript of several live channels is covered by tests only). 32 app tests, 275 server checks.
- 2026-11-21 · traffic · Empty sky on the phone ("rate limited · 0 cached"): adsb.lol was refusing requests after a night of app restarts, the desktop preview and test requests all from one address, and a freshly started app has nothing cached. The app now falls back to a second open source, adsb.fi, when adsb.lol refuses or fails. Planes were back on the phone after the new build (64 known); whether that answer came from adsb.fi or from adsb.lol relenting was not checked. Head-tilt to talk confirmed working by Kien.
- 2026-11-21 · phase 6 · X-Plane mode skipped for now at Kien's call. What remains across all phases needs the field, daylight or the headset rather than more code (see the open boxes above).
- 2026-11-21 · phase 6 · Two stretch goals. **Filters in the sky**: "only show helicopters in the sky" limits the compass bar, the brackets and the radar; "apply that filter to the sky" copies the list's filter; a marker on the HUD shows it is on. **Runway from the wind**: with no pattern traffic to go by, the runway most into the wind at the nearest weather station is used (live: "Runway 10, from the wind, 130 at 4 at Toledo Executive"). Both checked in the desktop preview on live data; 31 app tests and 251 server checks pass.
- 2026-11-21 · phase 4 · Capture extension confirmed in Kien's Chrome: all five player tabs captured through it, no sharing bars, the same audio levels arriving at the server as with the old way. No call has been transcribed through it yet (nobody was talking, 3 am).
- 2026-11-21 · phase 4 · Capture extension 0.3.1: reloading the extension cut its link to an already-open capture page ("The capture page is not answering", seen by Kien). It now puts its relay script back into the page itself. Checked in Chrome 149 against the real capture page.
- 2026-11-21 · phase 4 · Capture extension 0.3: "Open all feeds" opens every player tab from one button (player pages bookmarked in `feeds.json`), and on a player tab one click on the toolbar button or Option+Shift+C captures it with no popup. Capturing all tabs from a single click is not possible: Chrome only gives an extension a tab's audio on a tab the user invoked it on. Still not run end to end in a real Chrome.
- 2026-11-21 · phase 4 · Chrome extension (`mac-server/capture-extension/`) to capture player tabs without Chrome's "Sharing … to this tab" bars: its popup hands a tab's audio to the capture page, which does the rest. Checked in parts (the extension loads and gets a tab's audio id in Chrome 149; the page's side with a stand-in stream); not yet run end to end in a real Chrome. First design (the extension posting audio itself) was dropped: its requests to the local server never arrived in the test browser.
- 2026-11-21 · voice · Real takeoff times from the OpenSky Network (`mac-server/opensky.py`): "when did it take off?" now answers with the time and place the plane left the ground when OpenSky tracked it from there, and falls back to the estimate when it didn't. A plane with no route on file at least gets where it came from. Live: Kalitta 536 "took off from Chicago at 2:11 AM, 13 minutes ago"; a Falcon 20 with no route "took off near Dallas-Ft Worth at 12:57 AM"; ABX 405 from San Francisco had no ground start, so the estimate was used. 239 server checks pass.
- 2026-11-21 · voice · Weather where you are and official airport forecasts, from aviationweather.gov (`mac-server/forecast.py`): "what's the weather?", "what's the forecast for tonight?", "will it rain this afternoon?", "will it stay VFR?", "what's the weather when it lands?". Answered in 0 to 0.3 s on live data for Bowling Green (nearest forecast: Toledo, 14 miles). 219 server checks pass.
- 2026-11-21 · research · Aivana could not open a given address and return its contents (three tries). Found instead: OpenSky Network's free track API returns the current flight's path from its first point, which gives a real takeoff time and place (American 2760: first seen at Boston Logan at 00:41, matching its BOS-LAX route). Not built in yet.
- 2026-11-21 · voice · Range limit raised to 200 km at Kien's request (settings and voice; the feed asks every 8 s or slower above 100 km). Aivana's web search tested for flight times and weather (`docs/aivana.md`): it searches, in 6 to 11 s, but got the status of both flights in the air wrong and returned a six-hour-old weather report, so it is not used for either.
- 2026-11-21 · voice · "Set the range to 75 kilometers" changes how far out the compass bar and the sky show planes (5 to 100 km, same setting as AR radius; "reset the range", "what's the range"). Applied without restarting the traffic feed. Checked on the Pixel: 50 to 100 km brought an airliner 81 km away onto the bar.
- 2026-11-21 · phase 5 · On the Pixel, confirmed by Kien: the radio is audible. Audio took 8.9 s to start; with a 128 kbit/s stream and 2.5 s of recent audio sent at once it starts in 0.5 s. Mute, unmute, hide transcript, louder and disconnect all ran on the phone. A plane's card no longer hangs into the voice subtitles.
- 2026-11-21 · phase 5 · On the Pixel: connecting to a feed by voice works and the live audio plays (Toledo, Wood County and Cleveland Center were all connected); mute and transcript commands ran. Not yet measured: how long the audio takes to start, and focus on a controller icon by looking at it in the headset. An empty compass bar now says "No planes within 50 km · 80 farther out are in the list ☰" (the bare "No planes" beside a radar showing the runways read as a fault).
- 2026-11-21 · phase 4 · Callsign fixes from real calls: a flight number no longer runs into the next sentence ("Skywest 4129. Seven…"), tail fragments written in one piece are read ("570U"), and Whisper's radio prompt is now vocabulary per kind of feed (airline, mixed, pattern) with no example calls, after an example came back as a transcript and SkyWest flights were written as Skyhawks. The phone now tells the Mac which planes each controller is probably working, for spelling. One-word transcripts of static are dropped.
- 2026-11-21 · phase 5 · Controllers on the compass bar with live/stopped dots, cards, and "Can I access?": connects to a feed, plays its audio on the phone and scrolls its transcript; mute, volume and transcript are separate voice switches. Plane cards say who the plane is likely talking to. Checked in the desktop preview against the live captured feeds; phone and headset still to do.
- 2026-11-21 · phase 4 · **First real ATC audio.** Five LiveATC tabs captured; real calls transcribed with correct callsigns (Southwest 3454 on Columbus Approach, a Skyhawk on Cleveland Center). Content words are rougher ("altimeter" heard as "kilometer", "RNP" as "RMP"). Three faults found and fixed: call ids restarted with the server (new calls hidden from the capture page), a prompt label leaked into transcripts ("Callsigns, 945…"), noise transcribed as "!".
- 2026-11-21 · phase 4 · Radio audio now comes in through a browser tab: `mac-server/capture.html` (at `/capture`) shares the sound of a Chrome tab playing LiveATC's own player, and the server cuts and transcribes it as before. No stream addresses anywhere. Five feeds listed; the phone follows all of them. Checked with a test recording pushed through the new endpoint and with a stand-in audio stream on the page; not yet with a real LiveATC tab.
- 2026-11-21 · phase 4 · Radio-call linking built: feed workers, call splitter, radio parser, endpoints, phone matching/highlight/subtitle. Works end to end on test recordings; waiting on the LiveATC stream address to try real audio.
- 2026-11-21 · phase 2 · Runway in use detected from traffic (Auto is the default), entry rule fixed, stale positions no longer extrapolated. The recorded N442BG landing is a regression test: 25 app tests, 108 server checks.
- 2026-11-21 · phase 3 · Flight progress, arrival estimates and live weather added to the assistant; checked on real flights (JIA5240 CLT–SBN on approach, ASA829 JFK–HNL in cruise).
- 2026-11-21 · on the phone · First run on Kien's Pixel 7: app, GPS, traffic, USB link to the Mac, voice (after fixing speech detection). Watched a BGSU Seminole (N442BG) fly a left pattern and land on runway 18: the app had runway 28 set and labeled it wrong. Recording in `docs/recordings/`.
- 2026-11-20 · phase 3 · Voice assistant built: Mac server (Whisper, instant rules, Aivana, Kokoro voice), phone side (head-tilt, recording, actions, playback), access checks. Verified on the Mac with real audio and in desktop dev mode; not yet on a phone.
- 2026-11-20 · phase 3 prep · Read Aivana's API docs and summarized them in `docs/aivana.md`; added `mac-server/.env.example`.
- 2026-11-20 · phase 2 · Wood County runways and traffic pattern on the radar and in the sky; pattern-leg classifier with hysteresis; leg on the card and radar; Active runway setting. 20 unit tests pass. Drawing checked with synthetic planes only: no live pattern traffic at night.
- 2026-11-20 · phase 1 · BGSU planes are tagged, colored orange and filterable; trainer type names added (P28A = Piper PA-28 Archer, PA44 = Piper PA-44 Seminole). Checked on a live BGSU Archer (N337BG) 25 km west of 1G0.
- 2026-11-20 · data check · adsb.lol vs adsb.fi over 250 nm: 410 shared planes, positions within ~100 m (median), altitudes within 50 ft, callsigns identical.
- 2026-11-20 · phase 1 · Two-speed traffic (50 km AR feed + 250 nm wide feed), list view with filters/sorting/paging/open-plane, ☰ button, wider radar, on-demand routes from adsb.lol route files. Verified in desktop dev mode on live traffic; APK builds. Phone and daytime checks open.
- 2026-11-20 · phase 0 · Android build set up on the Mac (Homebrew `openjdk@21` + `android-commandlinetools`, SDK platform 36); `gradlew` made executable; debug APK builds. Not yet installed on a phone.
- 2026-11-20 · phase 0 · Sky-placement patch applied as written; app renamed to Bombirdier; type checks and TS/Python parity pass; verified in desktop dev mode on live traffic near 1G0. APK build and outdoor test still open.
- 2026-11-20 · setup · Repo created from SkyLens (history squashed to one initial commit; local `upstream` remote points at jaiden-lee/ar-plane-identifier). Plan and tracker added.
