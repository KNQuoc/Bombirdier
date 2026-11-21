# Bombirdier (this fork)

This repo is **Bombirdier**, Kien's personal fork of SkyLens. Before working on it, read [docs/bombirdier-plan.md](docs/bombirdier-plan.md) (the build plan, done phase by phase) and [PROGRESS.md](PROGRESS.md) (what's done). After finishing a piece of work: tick it in `PROGRESS.md`, add a line to its Log, and comment on or close the matching GitHub phase issue. New Bombirdier pieces get described in the "Bombirdier" section below as they're built. The rest of this file describes the original hackathon project and still applies to the shared code.

## Bombirdier

- **Sky placement (Phase 0).** When `HudState.pitchDeg` and `viewerAltM` are passed, `web/src/hud.ts` draws a corner bracket on each plane at its real spot in the camera view and hangs the focused plane's card under its bracket. Focus is the plane with the smallest true angle from the view center. Without those two fields the HUD is compass-only, as before (the web app passes neither).
  - Math: `elevationDeg()` (Earth curvature included) and `projectSky()` (pinhole, roll ignored) in `web/src/geo.ts`.
  - Data: `Plane.altitudeGeomFt` (ADS-B `alt_geom`, WGS84) in both normalizers; `LatLon.altM` from GPS; altitude is extrapolated with vertical rate between polls (`flights/feed.ts`).
  - Android (`app/android/src/main.ts`): pitch from the orientation sensor; viewer altitude from GPS, else `FALLBACK_GROUND_M` (205) + `EYE_HEIGHT_M` (1.75). Dev mode: ↑ ↓ set pitch.
- **Two-speed traffic (Phase 1), `app/android/src/traffic/`.** `startTraffic()` runs two pollers. *Near*: the existing `flights/feed.ts`, radius = AR radius (setting, default 50 km, max 200), every 5–30 s (8–30 s above 100 km, where each answer is several times bigger); only these planes reach the HUD (compass icons, sky brackets, focus card). *Wide*: `wide.ts`, 250 nm, about once a minute, dead-reckoned only when asked; it skips its turn while the near feed is throttled (both share adsb.lol's rate limit and the cooldown in `flights/adsb.ts`). `traffic.all()` merges them by id, near wins. "Wide traffic: on / Wi-Fi only / off" lives in `src/app-settings.ts` (Bombirdier-only settings, own storage key).
- **AR radius by voice.** "Set the range to 75 kilometers" (`ar_range {km}`, rule in `mac-server/rules.py`; 5 to 200 km, `km: 0` = the default) changes the same setting as AR radius on the settings screen. `traffic.setArRadius()` / `NearFeed.setRadius()` apply it without restarting the feed: the next answer from adsb.lol uses the new radius, and one still on its way for the old radius is dropped.
- **Two traffic sources.** `fetchPoint()` in `flights/adsb.ts` asks adsb.lol first and adsb.fi (`opendata.adsb.fi/api/v3/lat/…/lon/…/dist/…`, same readsb format) only when adsb.lol has just refused (429) or failed; each has its own cooldown. Without the second one, a rate limit right after the app starts (nothing cached yet) left the sky empty: seen on the phone after a night of reinstalls, with the desktop preview and test requests hitting adsb.lol from the same address. The feed's status names the source when it isn't adsb.lol ("live (adsb.fi) · 12 planes"). When testing, don't query adsb.lol from the Mac while the phone is running.
- **Position age.** `Plane.positionAgeS` (readsb `seen_pos`, in both normalizers) is how old a position already was when fetched. `extrapolate()` in `flights/feed.ts` counts it, so a plane that drops out of coverage (landing, low near the field) is moved for at most 60 s past its last real report instead of being flown on from the same stale position after every poll; altitude is carried forward 20 s at most.
- **Routes are on demand.** `lookupRoutes(planes)` fetches one small file per airline callsign from `vrs-standing-data.adsb.lol/routes/` and judges plausibility from the plane's position (the files can be stale). It is called for the near feed's planes and for a plane opened from the list, never for the 250 nm set. The batch `routeset` endpoints the original code used no longer work. `flight-service` (Python, web app only) still has the old lookup; only normalization is kept in parity.
- **List view (Phase 1), `app/android/src/list/`.** `list.ts` is the state and the actions (`show`, `hide`, `setFilter`, `clearFilter`, `sort`, `page`, `openRow`, `openPlane`, `count`): these are what voice calls in Phase 3. `filter.ts` is the `ListFilter` model (plain JSON; `sanitizeFilter` drops anything invalid). `kind.ts` guesses jet vs prop from the type designator, then category and speed. `draw.ts` draws the panel on the HUD canvas after `drawHud()` and maps taps back to rows. The ☰ button, taps, swipes and dev keys are wired in `main.ts`.
  - While the list is open the HUD gets `showCard: false` and `radarPlanes` = the filtered list; an opened plane is passed as `highlightIds` (pulse) and, if within the AR radius, `guideId` (compass arrow). Look straight at an opened plane and the panel steps aside for the regular card.
  - `web/src/hud.ts` gained those optional `HudState` fields plus `radarRangeKm`, radar ranges up to 463 km, and exports of `COLORS`, `fs`, `label`, `roundRect`. All default to the old behavior.
- **BGSU home fleet, `app/android/src/fleet/bgsu.ts`.** The planes this app is mostly for. `isBgsu()` matches tail numbers N<digits>BG that are propeller planes (plus a `KNOWN_TAILS` list to extend once the fleet is confirmed); `tagFleet()` sets `Plane.tag = 'BGSU'` and `Plane.accent` (orange) as planes come out of `livePlanes()` / `widePlanes()`. `tag` and `accent` are optional `Plane` fields the HUD understands generically: the tag goes on the card (`cardTag()` in `web/src/format.ts`), the accent colors the icon, bracket, radar dot and list row of a plane with no special status. List filter: `fleet: 'bgsu'`, which shows ground traffic too. When testing, look for BGSU planes first.
- **Home airport (Phase 2), `app/android/src/airports/`.** `1g0.ts` is Wood County: runway ends with FAA threshold coordinates, true headings and pattern sides, field elevation, TPA, and the geoid separation (charts are in feet MSL; GPS and ADS-B `alt_geom` are ellipsoid heights: `mslFtToEllipsoidM()` converts). `main.ts` uses it as `AIRPORT`, including for the fallback viewer altitude.
- **Traffic pattern (Phase 2), `app/android/src/pattern/`.**
  - `geometry.ts`: the runway frame (x along the runway from the landing threshold, y toward the pattern side, so left and right patterns look alike) and `buildPattern()`, the five legs as lines with altitudes.
  - `classify.ts`: `classify(plane, airport, runway)` gives a leg (`upwind`, `crosswind`, `downwind`, `base`, `final`, `entry`, `departure`) and a confidence from position + track rules; `createPatternTracker()` adds hysteresis (a different leg must come out twice, checks 2 s apart). The thresholds are first guesses, checked against one real landing so far (`docs/recordings/`, replayed in `npm test`): tune them on more live BGSU pattern traffic.
  - `runway.ts`: works out the runway in use from the traffic, because a wrong runway makes every label wrong (seen on the first live landing). A plane on final or climbing out over a runway decides it ("strong"); a plane level at pattern altitude on a downwind suggests it earlier ("weak", since each of the four runway ends has its own downwind line), but never overrides a landing or takeoff seen in the last 20 minutes. Used when the Active runway setting is Auto (the default); `runwayInUse()` in `main.ts` is what everything reads.
  - `overlay.ts`: turns the airport into what the HUD draws (`HudState.airport`): runways and pattern as bearing/distance from the viewer, plus a densely sampled copy with altitudes for the sky. Also picks a 5-15 km radar range when you're within 10 km of the field, so the pattern isn't a speck.
  - `main.ts` runs the tracker on the AR feed's planes each frame, writes the leg onto `Plane.note` (fourth card line, "Right downwind · RWY 28") and passes leg codes for the radar. Active runway is a setting (`app-settings.ts`): Auto, or a runway forced by hand or by voice ("we're using runway one zero", "runway back to automatic").
  - HUD side (`web/src/hud.ts`, optional): `airport` overlay, `Plane.note`, rim dots for planes beyond a fixed radar range, and the card slides aside rather than cover the radar.
- **Voice assistant (Phase 3).** Two halves.
  - **Mac server, `mac-server/`** (FastAPI, port 8787; see its README). `POST /api/voice/ask` takes base64 audio (or `text`) plus a context object and returns `{ transcript, answer, actions, source, timings }`. Steps: `transcribe.py` (mlx-whisper, on the Mac; drops what Whisper invents from silence or noise) → `rules.py` (instant answers for commands with one obvious meaning, and "what's that plane?" from the plane's own data) → otherwise `llm.py` (Aivana, the only file that knows about it; see `docs/aivana.md`). Aivana has no tool calling, so actions come back through its strict JSON Schema output: `tools.py` holds the flat action schema and validates what comes back. The key is in `mac-server/.env` (gitignored) and never goes to the phone.
  - **Phone, `app/android/src/voice/`.** `assistant.ts` runs listen → think → speak and owns the HUD subtitles (`HudState.voice`). `tilt.ts`: tip your head sideways past 30° for 0.8 s to start (uses the new `rollDeg` in `web/src/orientation.ts`); only armed while the server answers `/api/health`. `recorder.ts`: MediaRecorder, stops on 1.3 s of silence, audio sent as base64 JSON. `speak.ts`: plays the Mac's Kokoro audio, else Android TTS through `@capacitor-community/text-to-speech`. `actions.ts` applies the server's actions to the list, radar and runway, and words the reply itself when only the phone knows the answer (counts over the 250 nm traffic). `main.ts` builds the context (`voiceContext()`): focused plane, planes in view, BGSU planes, airport and runway, list state.
  - **Voice:** `mac-server/tts.py` speaks answers with Kokoro (mlx-audio), about 0.1–0.6 s per answer; `/ask` returns the audio as `speech`, and `/api/voice/speak` voices text the phone worded itself. The phone plays it (`speak.ts`) and falls back to Android TTS. All MLX work (Whisper, Kokoro) runs on one thread (`gpu.py`).
  - **Who the server answers** (`guard` in `main.py`): Host must be `localhost` or an IP (blocks DNS rebinding); bodies over 12 MB refused; `/api/voice/*` from anything but this Mac needs `X-Bombirdier-Token` = `BOMBIRDIER_TOKEN`. USB (`adb reverse`) arrives as loopback and needs no token. Server strings are escaped before they reach `innerHTML` (`escapeHtml` in `main.ts`).
  - **Flight questions** (`mac-server/flightinfo.py`): the phone sends each plane's position and its route's two airports (`cachedRouteInfo` in `flights/adsb.ts`). From those the Mac works out distance flown, distance to go, an arrival estimate (distance ÷ ground speed) and roughly when it left, and fetches current weather (METARs from aviationweather.gov, cached 10 min) for the origin, the destination and the station nearest the plane. Plain phrasings ("when does it land", "how far has it flown", "what's the weather at its destination") are answered there in under a second; everything else gets the same facts as context for Aivana. **Arrival times are estimates, and the answers say so**: there is no free source of airline schedules (see the module's docstring for what was tried). **Takeoff times are real when OpenSky has the flight** (`mac-server/opensky.py`): its free track endpoint returns the current flight's path from its first point, and if that point is on or near the ground it is the takeoff ("It took off from Chicago at 2:11 AM, 13 minutes ago"). A plane first seen already high up flew into coverage, so the estimate is used instead. For a plane with no route on file, the takeoff place is named after the nearest weather station ("took off near Miami"). Asked only when a question needs it, cached 15 minutes per plane, and it backs off when OpenSky says to; no key. "It" means the focused plane, else a plane opened from the list.
  - **Weather here and forecasts** (`mac-server/forecast.py`): "what's the weather?", "what's the forecast for tonight?", "will it rain this afternoon?", "will it stay VFR?", "what's the weather when it lands?". Current reports (METAR) and official airport forecasts (TAF) from aviationweather.gov, for the station nearest the user (Wood County has neither; the answer names the station and how far it is) or the plane's destination at its estimated arrival time. A TAF is a list of periods: `periods()` separates the prevailing ones (a "becoming" period only names what changes, so it is laid over the one before) from "at times" and "chance of" ones; `window()` turns "tonight" or "this afternoon" into hours. It reads the forecast out and never says whether it is safe to fly. The phone sends `viewer` (position to about a kilometer); without it Wood County is assumed. Aivana gets the same report and forecast as context lines. Aivana's own web search is not used for weather or flight times: tested and wrong (`docs/aivana.md`).
  - **Why rules first:** Aivana measured 3–6 s per call. Paging, simple filters, sorting, radar zoom, runway changes and "what's that plane?" never touch it.
  - **Speech units:** spoken distances are nautical miles, said as "miles" (the HUD shows km).
  - **Adding an action:** add it to `ACTIONS` + `ACTION_SCHEMA` + `describe_for_prompt()` in `mac-server/tools.py`, handle it in `app/android/src/voice/actions.ts`, and add a rule in `rules.py` if it has an obvious phrasing. The radio actions (Phase 5) went the same way, with their rules in `radiotalk.py`.
  - **Android:** `RECORD_AUDIO`, a `<queries>` entry for the TTS engine, and `res/xml/network_security_config.xml` allowing cleartext (the Mac server is plain http).
- **Radio calls (Phase 4).** Live ATC feeds are transcribed on the Mac, and a call that names a plane lights that plane up on the phone.
  - **How the audio gets in: a browser tab.** LiveATC offers only an in-browser player and forbids third-party use of its streams, so the server never connects to one and holds no stream addresses. The feed plays in LiveATC's own player in a Chrome tab; `mac-server/capture.html` (served at `http://localhost:8787/capture`) asks Chrome to share that tab's sound (`getDisplayMedia`; picking the tab is the user's click), downsamples it to 16 kHz mono in an AudioWorklet and posts a quarter of a second at a time, in order, to `POST /api/feeds/{id}/audio`. Never guess, scrape or hardcode a stream address. Chrome puts a "Sharing … to this tab" bar on the capture page per shared tab; `mac-server/capture-extension/` (MV3, loaded unpacked) avoids them: its popup gets the tab's audio as a stream id redeemable only by the capture page's tab (`chrome.tabCapture.getMediaStreamId` with `consumerTabId`) and passes it through a content script (`relay.js`, `window.postMessage`) to the page, which calls `getUserMedia` with it and carries on as usual (`attach()` in `capture.html`). The extension makes no network requests itself. Its popup opens every feed's player tab in one go (`"player"` in `feeds.json`: a bookmark to the page the site's own listen link leads to), and on a player tab one click on the toolbar button, or Option+Shift+C, captures it with no popup (`background.js`). It cannot capture all tabs from one click: Chrome grants an extension a tab's audio only on a tab the user has just invoked it on. Confirmed working in Chrome with five tabs (2026-11-21). When the extension is reloaded Chrome cuts its content script off from an open capture page, so `askPage()` in `lib.js` re-injects `relay.js` itself (`scripting` permission).
  - **Mac:** `feeds.json` lists feeds: `tab` (above; `page` = the public page to open, `listenTo` = the feed's name there), `stream` (a plain audio stream this Mac may connect to itself, with a `streamUrl`: one ffmpeg connection, only while the phone asks for calls, stopped two minutes after it last asked, reconnect at most every 30 s), `file` (a local recording looped, for tests; `FEEDS_FILE` in the environment points at another list). `feeds.py`: audio → `splitter.py` (cuts it into calls at pauses; pure Python) → Whisper with a prompt for that feed (`transcribe.radio_prompt()`: vocabulary for the feed's `"talk"` in `feeds.json`, `airline` / `mixed` / `pattern`, never example calls, which Whisper reads back as transcripts) plus the callsigns that controller is probably working (the phone posts them per feed, from `whoControls`) → `radio_parse.py` (callsign tokens such as `DAL1830` or the tail fragment `901BG`, and position reports) → an event in that feed's ring buffer. A tab feed is "online" while audio keeps arriving (silence included) and gets a fresh splitter when capture restarts. Nothing is written to disk but a temporary wav per call, deleted at once. Endpoints are in `radio.py`; the audio endpoint refuses requests whose `Origin` is another website.
  - **Phone, `app/android/src/radio/`:** `radio.ts` polls `/api/radio/events` twice a second for every feed at once (no streaming through Capacitor's HTTP) and posts the callsigns around every 5 s. The first feed in `feeds.json` is the home frequency: everything said on it is shown; from the other feeds only calls that match a plane. `match.ts` finds the plane (exact callsign or registration, else a tail number ending in the token; closer plane wins; airline callsigns must match in full) across near and wide traffic; `draw.ts` draws the subtitle. `main.ts` adds the matched plane to `HudState.highlightIds` for 8 s and appends "📻 said left downwind 28" to the card note when a call reported a leg.
  - **Load:** every captured feed is transcribed on the one MLX thread the voice assistant also uses; a feed with more than four calls waiting skips the new ones.
  - **Not yet tried on real ATC audio.** The pipeline is verified with computer-voice recordings pushed through the audio endpoint, and the capture page with a stand-in audio stream; no real LiveATC tab has been captured yet.
- **Filter on the sky (Phase 6), `app/android/src/sky-filter.ts`.** "Only show helicopters in the sky" (`sky_filter {filter?, fromList?}`, rules in `mac-server/rules.py`) limits what `main.ts` hands the HUD as `planes`: compass icons, sky brackets, focus and radar. It reuses the list's `ListFilter` and `matches()` minus sorting and paging, and keeps ground traffic unless the filter says otherwise. "Apply that filter to the sky" copies the list's filter; no filter = everything again. It is session-only on purpose (a forgotten filter looks like missing data), and `sky-filter-draw.ts` puts a "SKY · only …" marker above the compass while one is on. The pattern tracker and runway detector still see every plane.
- **Runway from the wind (Phase 6), `app/android/src/pattern/wind.ts`.** `runwayInUse()` in `main.ts` goes: set by hand → what the traffic shows (`pattern/runway.ts`) → the runway most into the wind (`runwayForWind()`) → the calm-wind runway. The wind is the nearest weather report, asked from the Mac every ten minutes (`GET /api/weather/wind?lat=&lon=`); under 4 knots or variable decides nothing. `runwaySource()` says which of these it was ("from the wind, 130 at 4 at Toledo Executive").
- **Controllers and listening in (Phase 5).** Controllers appear on the compass bar; looking at one (or at a plane) and saying "Can I access?" plays that frequency on the phone with a scrolling transcript.
  - **`app/android/src/atc/`:** `facilities.ts` is the hand-made list (Wood County CTAF, Toledo Approach, Detroit Approach, Cleveland Center, Columbus Approach: position, frequencies, the feed id in `mac-server/feeds.json`). `whoControls.ts` guesses who a plane is talking to from position and altitude (rough stand-ins for real airspace, hence "Likely" everywhere) and words the card's radio line; a call actually heard on a feed (`radio.heardOn()`) replaces the guess with "✅ heard 40s ago". `stations.ts` turns facilities into what the HUD draws.
  - **HUD (`web/src/hud.ts`, optional fields):** `HudState.stations` (`HudStation`: bearing, dot color, card lines) draws a radio-mast icon on the compass bar. A station counts as sitting on the horizon, so its distance from the view center is `hypot(bearing offset, pitch)`; whichever of the nearest plane and the nearest station is closer to the center gets the focus and the card. `HudResult.station` is the focused one. `HudState.hideRadar` leaves the radar out. `Plane.note` may hold several lines (`\n`).
  - **Listening (`app/android/src/radio/listen.ts`):** connected = one feed's audio in an audio element plus its transcript on the HUD (`drawConnected` in `radio/draw.ts`: a LIVE pill at the top, the last four calls where the radar is). Audio and transcript are separate switches, remembered per feed for the session. The audio is `GET /api/feeds/{id}/audio` on the Mac: an MP3 stream encoded by one small ffmpeg per listener from the audio already arriving, so listening adds no connection to the feed's source. Over Wi-Fi the phone first asks `POST /api/feeds/{id}/listen` for a one-time ticket (an audio element can't send the token header). `main.ts` silences the radio while the assistant listens (the microphone would hear it) and lowers it while it thinks and talks.
  - **Voice (`mac-server/radiotalk.py`, called from `rules.py`):** connect ("Can I access?", "listen to Detroit"), disconnect, mute/unmute/louder/quieter, show/hide transcript, "transcript only", "audio only", "what did they just say?", "who's on this frequency?", "who is it talking to?", "is Toledo live?". All answered without Aivana. The phone sends `station` (the controller in view), `focus.radio` (the plane's controller guess) and `radio` (connection state, facilities); the server adds `feeds` and `radioRecent` (recent calls) before the rules run, and `prompt.py` gives Aivana the same for everything else ("what did they tell Delta?"). Actions: `connect_feed`, `disconnect_feed`, `radio_audio`, `transcript`.
  - **On the phone:** connecting by voice and the live audio work, and the audio starts in about half a second: the stream is 128 kbit/s and begins with the last 2.5 s of audio, because a player waits for a fair amount of data before it starts (at 32 kbit/s that took 9 s). Not yet tried: looking at a controller icon in the headset.
  - **Empty bar:** with no planes inside the AR radius, `HudState.emptyText` says how many are farther out (they are in the list and on its radar, not on the bar).
- **Tests.** `cd app/android && npm test` (list, fleet, pattern, radio matching and controller logic, hand-made planes, no network) and `cd mac-server && python3 test_server.py && python3 test_radio.py` (rules including the radio ones, speech wording, action validation, flight info; radio parser and call splitter). Run them with the other checks.
- **Name.** The app is called Bombirdier (`capacitor.config.ts`, both `strings.xml` files, page title). `appId` is still `com.arplaneidentifier.app` on purpose: changing it would install a second app and lose compass calibration.
- **Desktop testing.** `npm run dev`, then `http://localhost:5174/?dev=1&at=41.391,-83.6301` (`at` = a fixed position, for browsers without geolocation). Keys: ← → ↑ ↓ look around, `V` talk (again to send), `L` list, `PgUp`/`PgDn` page, `F` filter presets, `1`–`8` open a row, `Esc` back, `R` radar range, `C` listen to the controller in view (again to stop), `M` mute, `T` transcript, `S` the list's filter on the sky (again = off). With `mac-server/run.sh` going, `bombirdier.ask('show me the helicopters')` in the console sends a typed question through the whole voice path.

---

# AR Plane Identifier

Hackathon project (built Fri 2026-09-25 → Sat 2026-09-26). Team: **Jaiden, Wesley, Allison**.

**Guiding principle:** maximize demo "wow" for minimum effort. Prefer the simplest thing that works on stage over the "correct" thing. Mock data and hardcoded fallbacks are fine if they keep the demo reliable.

**How we work:** all code is written by AI agents (one per teammate), supervised by that teammate. This file is the shared source of truth. Each agent stays inside its own workstream (see [Ownership rules](#ownership-rules-for-agents)).

## The idea

Point your phone (in a Google Cardboard headset) at a plane in the sky, and see a label telling you what it is: flight number, aircraft model, origin → destination, etc.

- The phone shows a **stereo view**: two identical side-by-side camera previews, one per eye, so it works in Cardboard.
- A "headband" **compass bar** near the top of the view (drawn identically in both halves) shows a **plane or helicopter icon** for every aircraft in view, **positioned at its real direction**.
- The plane you're looking at (within ±7.5° of center) gets an **info card** that drops down right under the compass. The middle of the view stays clear.
- Flight data comes from **adsb.lol** (free ADS-B API).

**Stretch goal:** a voice agent (Grok). Say "hey Grok, ..." and ask about the plane you're looking at. Grok gets the plane's data as context and can also answer from general knowledge ("how many seats does an A321 have?").

## How "looking at a plane" works

We don't do any computer vision. We use the phone's sensors plus geometry:

1. **Inputs:** user's GPS position (lat/lon) and the compass heading the camera is pointing (degrees clockwise from north).
2. **View cone:** two rays from the user at `heading − fov/2` and `heading + fov/2`, where `fov` is the **horizontal field of view of what's shown in each eye** (so labels line up with the camera image). The browser can't report camera FOV, so it's a calibrated config constant.
3. **Nearby planes:** fetch all aircraft within a radius of the user. Defaults live in flight-service: **15 km** live (`DEFAULT_RADIUS_KM`), **40 km** in demo mode (`DEMO_RADIUS_KM`). The start screen has a **Search radius (km)** field: blank = those defaults; a number is sent as `radiusKm` and overrides them (and filters the fixture in Offline mode). No code change needed to change the radius.
4. **Filter:** for each plane, take the bearing from the user to the plane. If it falls between the two rays, the plane is "in view".
5. **Display:** a plane/helicopter icon on the compass bar for every aircraft in view (oriented by its direction of travel relative to your line of sight, smaller when farther away, **colored by status**: see [Aircraft status colors](#aircraft-status-colors)); the info card only for the closest plane **if it's within ±7.5° of center** (the "focus cone", 15° total). Screen x uses a pinhole projection: `x = eyeCenterX + tan(angleDiff) / tan(fov/2) * (eyeWidth/2)`.

### 2D simplification

We flatten 3D to 2D: **altitude is ignored** for detection. We only care about horizontal direction (azimuth), not how far up you tilt the phone. Everything is a point on a flat map, and the cone is a 2D wedge.

### Math conventions (keep consistent across the team)

- Angles in **degrees**, bearings **clockwise from true north**, normalized to `[0, 360)`.
- Signed angle difference (handles 0°/360° wraparound): `diff = ((bearing − heading + 540) % 360) − 180`. In view if `abs(diff) <= fov/2`. Negative = left of center.
- Units: distance **km**, altitude **feet**, speed **knots** (aviation convention, matches ADS-B data).

### Known gotchas

- **Heading ≠ where the camera points.** In a Cardboard, the phone is landscape and the rear camera points out the back. Raw compass alpha refers to the top edge of the phone, so the camera direction must be derived from full device orientation (alpha/beta/gamma).
- **Android:** use the `deviceorientationabsolute` event (north-referenced). iOS uses `webkitCompassHeading` and needs a permission prompt. **Android is the primary target**; iOS is nice-to-have.
- **Magnetic vs true north.** Compass is magnetic; flight data is true north. Apply declination (a constant for the demo location is fine).
- **Indoor compass is unreliable** (steel, electronics). Another reason demo mode matters.
- **Compass noise.** Smooth the heading (e.g. exponential moving average) so labels don't jitter.
- **One tap to start.** Camera, mic, orientation, and audio playback all need a user gesture. A single "Start" button (tapped before the phone goes into the Cardboard) unlocks everything.
- **HTTPS required** for camera/geolocation/sensors → we test via **ngrok** (agent must be **≥ 3.20**; older versions are rejected on free accounts — run `ngrok update`). The free URL changes on every restart unless you use your free static domain (`ngrok http 5173 --url <domain>`).
- **Windows + agents: always read/write files as UTF-8.** Python's `open()` defaults to cp1252 on Windows and silently corrupts characters like `·`, `✈`, `°` (this already broke `index.html` once). Pass `encoding="utf-8"` or use the editor tools.

## Demo mode (required — the demo is indoors)

- **Fixed location:** GPS is ignored; the user is pinned to a fixed lat/lon (Georgia Tech, near ATL — see [Decisions made](#decisions-made)).
- **Frozen dataset:** a snapshot of real adsb.lol data around that location (captured once, saved as a fixture), so the demo doesn't depend on live traffic or network. Planes should be spread around 360° so turning around in the room reveals different planes.
- **Heading is still live** from the phone sensors. That is the part judges experience.
- **Desktop dev mode** (for agents/devs without a phone): fixed location + heading controlled by keyboard arrows or a slider.

## Voice activation (stretch; no button available)

There's no Cardboard button and the phone is inside the headset, so activation must be hands-free:

- **Primary: always-on wake phrase.** Browser `SpeechRecognition` in continuous mode (works in Android Chrome) listens constantly; when the transcript contains "hey grok" (fuzzy match: "hey grock", "a grok", "hey rock", ...), the rest of the utterance (or the next one) is the question. Recognition stops after silence, so it must auto-restart.
- **Fallback: head gesture.** e.g. tilt head sideways (roll > ~30° for ~1s) to start listening. Robust in a noisy hackathon room.
- Answers spoken back via browser `speechSynthesis` (simplest), and shown briefly as text in the HUD.

## Architecture

```
Phone browser (web app, via ngrok HTTPS)
  │
  ├─ GET  /api/flights/nearby ──► flight-service (Wesley)  ──► adsb.lol
  └─ POST /api/voice/ask ───────► voice-service  (Allison) ──► Grok (xAI API)
```

- The web app's dev server **proxies** `/api/flights/*` and `/api/voice/*` to the two services. Result: **one ngrok tunnel**, no CORS issues.
- **Division of math:** the flight service takes the user's lat/lon/heading, computes each plane's `bearingDeg`, `distanceKm` and `offsetDeg`, and does the cone filter. Between polls the web app re-positions labels every frame from `bearingDeg` + its live heading (the head moves faster than we poll), so `bearingDeg` must always be present.
- **Update rate: 1 s everywhere.** The web app polls `/api/flights/nearby` every **1 s** (next poll starts 1 s after the previous one finishes, so slow responses never pile up). flight-service caches adsb.lol positions for **1 s** (`_point_cache` in `app/adsb.py`), so several phones polling still means at most ~1 upstream call per second. adsb.lol **rate-limits (HTTP 429)** at this rate, so `fetch_point()` (a) snaps the query center to a ~1 km grid so GPS jitter reuses the cache, (b) backs off for `Retry-After` (default 5 s) after a 429, and (c) serves the most recent good data (any position) instead of an empty sky while upstream is failing. Routes stay cached 30 min per callsign. Demo mode polls too, but its snapshot is frozen.
- The xAI API key lives **only** in voice-service (never in the browser).

### Repo layout and ownership

| Path | Owner | What |
|---|---|---|
| `web/` | **Jaiden** | Web app: camera, stereo view, orientation/heading, HUD + labels, cone filter, demo/dev mode UI, dev proxy, integration |
| `web/src/voice/` | **Allison** | Browser-side voice: mic, wake phrase / gesture trigger, speech-to-text, text-to-speech, calls `/api/voice/ask` |
| `voice-service/` | **Allison** | Backend: builds the Grok prompt from question + plane context, calls Grok, returns answer |
| `flight-service/` | **Wesley** | Backend: adsb.lol fetching, normalization to `Plane`, bearing/distance math, aircraft type names, origin/destination lookup, demo snapshot |
| `app/android/` | **Everyone** (Wesley, Allison, Jaiden) | **SkyLens**, the standalone Android app (Capacitor APK): live planes around the phone's GPS straight from adsb.lol, no servers, no voice. Imports the HUD, stereo, orientation, camera, geo, format and config modules from `web/src` read-only, so changes there can break its build: run `npm run apk` in `app/android/` to check. See `app/android/README.md` |
| `shared/` | **Everyone** (change only with team agreement) | `fixtures/demo-planes.json` (sample response for the web app to develop against before the service is ready) |
| `CLAUDE.md` | **Everyone** | This file. Contract changes go here first. |

### Local ports

| Service | Port | Routes mounted at |
|---|---|---|
| web (dev server) | 5173 | `/` |
| flight-service | 8001 | `/api/flights/...` |
| voice-service | 8002 | `/api/voice/...` |

Services mount routes under their full `/api/...` prefix so the proxy needs no path rewriting.

## Contracts (the interfaces between workstreams)

### `Plane`

```ts
type Plane = {
  id: string;                  // ICAO 24-bit hex, stable key (e.g. "a1b2c3")
  callsign: string | null;     // e.g. "UAL123" (trimmed)
  registration: string | null; // e.g. "N12345"
  typeCode: string | null;     // ICAO type designator, e.g. "B738"
  typeName: string | null;     // human-readable, e.g. "Boeing 737-800"
  airline: string | null;      // e.g. "United Airlines", if derivable from callsign
  origin: string | null;       // airport code (IATA preferred), if available
  destination: string | null;
  lat: number;
  lon: number;
  altitudeFt: number | null;
  groundSpeedKt: number | null;
  trackDeg: number | null;     // direction the plane is moving
  verticalRateFpm: number | null; // ft/min, + = climbing (readsb baro_rate, else geom_rate)
  distanceKm: number;          // from the query position
  bearingDeg: number;          // from the query position, [0, 360), true north
  offsetDeg?: number;          // signed angle from the request heading, (-180, 180], negative = left
  category: string | null;     // raw ADS-B emitter category, e.g. "A3" (large), "A7" (rotorcraft)
  kind: 'plane' | 'helicopter'; // 'helicopter' if category A7 or a known helicopter type code
  onGround: boolean;           // readsb alt_baro == "ground"
  emergency: string | null;    // "general" | "minfuel" | "nordo" | "unlawful" | "downed", or null
  military: boolean;           // adsb.lol dbFlags bit 1
  medical: boolean;            // lifeguard status or air-ambulance callsign (best-effort)
};
```

Any field may be `null` except position/distance/bearing (and `kind`, which is always set). The UI must handle missing data gracefully. The web app treats `verticalRateFpm` as optional (older data lacks it) and shows it on the info card's stats line (`↑ 1,200 fpm` / `↓ 800 fpm` / `level` under 150 fpm; hidden on the ground).

`kind` is derived in flight-service (`_kind()` in `app/normalize.py`): `category == "A7"` **or** `typeCode` in `HELICOPTER_TYPES` (catches helicopters that don't broadcast a category). Everything else is `'plane'`. The web app treats a missing `kind` as `'plane'`.

Status fields are also derived in `app/normalize.py`:
- `emergency`: readsb `emergency` status if it's a real emergency, else from squawk 7500 (`unlawful`) / 7600 (`nordo`) / 7700 (`general`). `"lifeguard"` is **not** an emergency (it's a medical-priority flight) and sets `medical` instead.
- `military`: adsb.lol `dbFlags & 1`.
- `medical`: `emergency == "lifeguard"` or callsign starts with an air-ambulance prefix (`MEDICAL_CALLSIGN_PREFIXES`: `GRDIAN`, `LIFE`, `MEDEVAC`, ...). ADS-B has no reliable medical flag, so this misses operators that fly under tail numbers.

### Aircraft status colors

The web app picks **one** status per aircraft (`aircraftStatus()` in `web/src/format.ts`), most important first:

| Priority | Status | Color | Card tag |
|---|---|---|---|
| 1 | `emergency` set | **blinking red** (400 ms) | `EMERGENCY` / `EMERGENCY · RADIO FAILURE` / ... |
| 2 | `onGround` | grey | `ON THE GROUND` |
| 3 | `medical` | purple | `MEDICAL` |
| 4 | `military` | green | `MILITARY` |
| 5 | otherwise | HUD blue (focused: yellow) | none |

The focused aircraft is larger; if it has a status color, it keeps that color with a yellow outline, and its info card's accent bar, notch and tag line use the status color. Colors live in `STATUS_COLORS` in `web/src/hud.ts`. The demo snapshot has 21 aircraft on the ground and 1 medical (`GRDIAN1`), no emergencies or military; those show up on live data.

### Flight service

`GET /api/flights/nearby?lat={lat}&lon={lon}&heading={deg}&fovDeg={deg}&radiusKm={r}&demo={0|1}`

- `heading`: degrees clockwise from true north that the user is facing.
- `fovDeg`: cone width; return planes with `abs(offsetDeg) <= fovDeg/2`. Default 60. The web app will often send a wider value than what's visible (or `360` for the radar / off-screen arrows), so `fovDeg=360` must return every plane in the radius.
- If `heading` is omitted, skip the cone filter and omit `offsetDeg`.

```json
{
  "center": { "lat": 37.62, "lon": -122.38 },
  "demo": false,
  "fetchedAt": "2026-09-25T20:00:00Z",
  "planes": [ /* Plane[] sorted by abs(offsetDeg) if heading given, else by distanceKm */ ]
}
```

- `demo=1`: ignore `lat`/`lon`, use the fixed demo location + frozen snapshot. `center` tells the client where it "is".
- Should never 500 on adsb.lol failures. Return last cached result (or empty list) instead.
- adsb.lol notes (verify against their docs): nearby-aircraft endpoint is along the lines of `https://api.adsb.lol/v2/point/{lat}/{lon}/{radius_nm}` (radius in **nautical miles**), readsb-style fields (`hex`, `flight`, `r`, `t`, `lat`, `lon`, `alt_baro`, `gs`, `track`). Origin/destination is **not** in the position data; adsb.lol has a separate route lookup by callsign (`routeset`). Treat routes as best-effort.

### Voice service

`POST /api/voice/ask`

```json
// request
{ "question": "what kind of plane is that?", "plane": { /* Plane */ } | null, "nearbyPlanes": [ /* Plane[], optional */ ] }
// response
{ "answer": "That's United 123, a Boeing 737-800 heading to Denver..." }
```

- Answers should be **short and spoken-friendly** (1–3 sentences, no markdown). They are read aloud.
- If `plane` is null, answer generally or say no plane is in view.

### Browser voice module (Allison's `web/src/voice/` ↔ Jaiden's app)

```ts
startVoice(opts: {
  getCurrentPlane: () => Plane | null;    // app provides current centered plane
  getNearbyPlanes: () => Plane[];
  onStateChange: (s: "idle" | "listening" | "thinking" | "speaking") => void;
  onTranscript?: (text: string) => void;   // what the user said
  onAnswer: (text: string) => void;        // app shows it in HUD
}): { stop: () => void };
```

Jaiden's app calls `startVoice` after the Start tap and renders the state indicator + answer text. Allison's module owns everything about audio.

## Ownership rules for agents

1. **Only edit files in your owner's paths** (table above). If you need something from another workstream, stub/mock it on your side and tell your human.
2. **Contracts are frozen unless the team agrees.** If a contract must change, stop and tell your human. Don't silently change request/response shapes.
3. **Develop against mocks.** Web uses `shared/fixtures/demo-planes.json` until flight-service is up; voice-service can be tested with curl; flight-service can be tested with a script/curl.
4. **Every workstream must run standalone** and degrade gracefully if the others are down (e.g. web still shows labels if voice-service is offline).
5. Keep it simple. It's a hackathon. No auth, no database, no tests beyond what helps you move faster.

## Workstream priorities

**Jaiden — web app + integration**
1. ✅ Start button → rear camera → side-by-side stereo view on Android Chrome over ngrok, with in-headset calibration (see [Web app notes](#web-app-notes)).
2. ✅ Camera heading from device orientation (+ smoothing, declination); desktop dev mode with arrow-key heading.
3. ✅ Cone filter + compass-bar aircraft icons + info card for the focused plane, using the fixture.
4. ✅ Hook up live flight-service (polling, Data mode on the start screen, demo fallback).
5. ✅ Mount voice module; show listening/thinking state and answers (subtitles near the bottom of the view).
6. Polish: ✅ FOV calibration, ✅ compass strip, ✅ off-screen arrow to the nearest plane, ✅ markers for other in-view planes; ✅ radar mini-map; still to do (if time): true vertical placement from altitude + phone pitch.

**Wesley — flight service**
1. `/api/flights/nearby` returning the contract shape from adsb.lol with correct bearing/distance.
2. Demo mode: pick location, capture snapshot, commit fixture (also copy a sample into `shared/fixtures/demo-planes.json` early so Jaiden can build against it).
3. Enrichment: `typeName` from type code, `airline` from callsign prefix, origin/destination via route lookup.
4. Caching/rate-limit safety.

**Allison — voice**
1. `voice-service` `/api/voice/ask` calling Grok with plane context, testable by curl.
2. Browser module: continuous speech recognition + "hey grok" detection + TTS.
3. Head-tilt fallback trigger.
4. Prompt tuning for short, fun, accurate spoken answers.

## Decisions made

- **Stack:** `web/` = Vite + **plain TypeScript** (no framework; the HUD redraws every frame). `flight-service/` and `voice-service/` = Python + FastAPI (each with its own `requirements.txt` and `.venv`). The only coupling between them is the HTTP/JSON contracts above.
- **Demo location:** user pinned to **Georgia Tech campus (33.7756, -84.3963)**, with Atlanta Hartsfield-Jackson (ATL, ~15 km south) traffic around it. Demo radius may be raised (e.g. ~30–40 km) to get enough planes spread around 360°. Wesley may adjust if the real snapshot is lopsided.
- **Heading is true north** from the compass (no manual "recenter"), with Atlanta declination hardcoded as −5.3° (`MAG_DECLINATION_DEG` in `web/src/orientation.ts`). Indoors it may be off by 10–30°; accepted.
- **Demo plane layout:** planes spread around 360° (like real traffic); the off-screen arrow guides the viewer to the nearest one.
- **Target phones:** Google **Pixel 10** (primary), Galaxy S22+ (backup), Android Chrome. iPhone 13 mini is not a demo target.
- **Info card:** 3 compact lines: `DL 1234 · Delta Air Lines` / `Airbus A321-200 · LGA → ATL` / `4,200 ft · ↓ 800 fpm · 180 kt · 8.4 km`. ICAO callsigns are shown with IATA codes for common airlines (`DAL1234` → `DL 1234`, map in `web/src/format.ts`).
- **HUD layout:** everything hangs off the compass bar near the top of the view (plane/helicopter icons on the bar, degree labels + heading under it, info card attached under that). Nothing in the middle of the view except the crosshair. Planes are placed horizontally only (true elevation placement is a stretch).
- **Fixture:** `shared/fixtures/demo-planes.json` currently holds **synthetic** planes (correct bearings/distances from GT) so web work can start now. Wesley replaces it with a real adsb.lol snapshot of the same shape.

## Decisions still open

- Camera FOV value for the demo phone. It depends on the calibrated camera zoom and the crop into each eye, so measure it after the zoom setting is final.

## Web app notes

Code lives in `web/src/`:

| File | What |
|---|---|
| `main.ts` | Start flow, per-frame loop, DOM overlay (crosshair, toasts), calibration input |
| `config.ts` | Phone presets (screen size, camera FOV) + persisted settings |
| `camera.ts` | Rear camera + hardware zoom |
| `stereo.ts` | Two-eye layout (lens spacing, tilt, shift, size) with a HUD canvas per eye |
| `orientation.ts` | Rear-camera heading + pitch from sensors, smoothing, declination |
| `geo.ts` | Angle helpers, visible-FOV estimate, pinhole projection |
| `planes.ts` | `Plane` type, fixture feed, live flight-service feed, GPS |
| `hud.ts` | Canvas HUD: compass bar, plane/helicopter icons, info card, edge arrow, voice subtitles. Layout constants at the top |
| `format.ts` | Info-card text, callsign formatting, aircraft status |
| `cast/` | Casting the view to a laptop: `compositor.ts` (mono camera + HUD frame), `publisher.ts` (phone), `viewer.ts` (`/cast.html`), `rtc.ts` |
| `vr/` | VR mode (Three.js): `vr.ts` (stereo render + head tracking + aircraft), `world.ts` (sky, ground, ATL runways, skyline, rooftop), `models.ts` (low-poly airliner/helicopter), `scenario.ts` (scripted ATC scenario feed), `local.ts` (flat local coordinates around GT) |
| `../server/cast-signaling.ts` | Vite dev-server plugin: WebRTC signaling relay at `/api/cast/*` |

Run with `npm run dev` in `web/` plus `ngrok http 5173`.

**Running voice-service:** `.venv/Scripts/python -m uvicorn main:app --host 127.0.0.1 --port 8002` in `voice-service/`, with the LLM key in `voice-service/.env` (gitignored; see `.env.example`). It only reads `.env` at startup, so restart after changing it.

**URL options:** `?dev=1` (desktop: arrow keys turn, camera optional, no fullscreen) · `?data=demo|live|fixture` (override the start screen's Data setting) · `?orient=event` (force `deviceorientationabsolute` instead of `AbsoluteOrientationSensor`).

- **Stereo layout:** each eye's image is centered under its Cardboard lens using physical mm (CSS px per mm comes from a per-phone preset of the screen's long edge), not at 1/4 and 3/4 of the screen.
- **Camera:** requests a **4:3** stream (1440×1080). A 16:9 stream cropped to the near-square eye loses ~37% of its width and looks very zoomed in. The image fills each eye (`object-fit: cover`); the field of view is widened with the camera's hardware zoom (defaults to the minimum, i.e. ultrawide), not by shrinking the image.
- **Heading:** the rear camera looks along the device's −Z axis, so heading = compass direction of −(3rd column of the device→earth rotation matrix). This works with the phone in landscape or crooked in the headset (raw `alpha` would follow the phone's top edge). The direction vector is smoothed (not the angle, so 359°→0° doesn't jump). Verified numerically: quaternion and Euler paths agree.
- **FOV:** estimated from the preset's main-camera FOV ÷ hardware zoom × `object-fit: cover` crop, times a calibrated `fovScale`.
- **Plane data** is picked by the **Data** dropdown on the start screen (saved in settings):
  - **Demo snapshot** (default): flight-service with `demo=1` (fixed Georgia Tech location, frozen snapshot, no GPS). If the service has never answered, it shows the fixture instead so the sky is never empty on stage.
  - **Live (GPS)**: flight-service with the phone's GPS position (asks for location permission).
  - **Offline**: `shared/fixtures/demo-planes.json` imported directly (Vite `server.fs.allow: ['..']`), no backend.

  The feed polls `/api/flights/nearby` every 1 s with `fovDeg=360` (`radiusKm` only if set on the start screen) and does the cone filter per frame from `bearingDeg` + live heading. On errors it keeps the last good data. When there are no planes at all, the HUD shows the feed status under the compass (e.g. "No planes · live · waiting for GPS").
- **Show planes on the ground** (start-screen checkbox, `showGrounded`, default on): when off, `main.ts` drops `onGround` aircraft before anything else sees them, so the compass bar, card, radar, edge arrow and the voice context all ignore them. The "No planes" status then says how many were hidden.
- **Running the full stack locally:** `npm run dev` in `web/`, flight-service with `.venv/Scripts/python -m uvicorn app.main:app --host 127.0.0.1 --port 8001` in `flight-service/`, and `ngrok http 5173`. The Vite proxy targets `127.0.0.1` (not `localhost`): on Windows, `localhost` tries IPv6 first and adds ~2 s per request.
- **In-headset calibration** (saved in localStorage) is **locked by default** so stray touches do nothing. **Double-tap the middle** to unlock, then middle tap cycles **zoom → tilt → spacing → shift → size → fov → info → locked**, left/right taps adjust. It re-locks after 6 s idle (except on info). **Tilt** matters most in practice: the phone never sits perfectly level in the headset, and a crooked phone puts one eye's image higher than the other (double crosshair). Tilt rotates the whole two-eye layout to compensate.
- **Voice (Allison's `web/src/voice/`):** `startVoice()` is called synchronously inside the Start tap (mic + speech need the gesture), when the start screen's **Voice** checkbox is on (default). Each frame `drawHud()` returns the focused plane and in-view planes (with `offsetDeg`); the voice module reads those when a question is asked. Voice state, the question, and the answer render as subtitles near the bottom (`VOICE_Y` in `hud.ts`); answers linger 7 s after speaking. Answers are spoken by the phone's `speechSynthesis` (the LLM only returns text). Desktop dev mode: **V** = `voice.listen()` (skip the wake phrase).
- **Radar mini-map** (`drawRadar()` in `hud.ts`): heading-up (your view cone points up), lower-left of each eye (`RADAR_X/Y/R`). Dots at true bearing/distance, colored by status, focused plane yellow; blue wedge = visible FOV, yellow wedge = ±7.5° focus cone; N/E/S/W (N in yellow) and 30° ticks orbit the rim as you turn; range auto-snaps to 5/10/15/20/30/40/60/80/120 km to fit the farthest plane. Hidden while a voice question/answer is on screen (they share the bottom of the view).
- **Fixture changes:** `vite.config.ts` explicitly watches `../shared` (it's outside the web root, so Vite otherwise keeps serving a stale copy of `demo-planes.json` after it's regenerated).
- **VR mode ("digital tower")**: start screen **View → Virtual sky (VR)** instead of Camera (AR). No camera: a Three.js scene of Atlanta is rendered instead, with aircraft placed at their real position/altitude/heading. Works with any Data mode (live traffic in a virtual sky), and pairs with **Data → Simulated ATC scenario**.
  - **Rendering:** one off-DOM `WebGLRenderer` renders **both eyes in one pass** into a double-wide canvas (viewport + scissor per half, cameras 64 mm apart = true stereo), then each half is copied into that eye's 2D canvas (`.eye-vr`, under the HUD canvas). Standard depth buffer (near 1 m, far 300 km, sky dome 250 km); ground-level decals (runways, roads, airfield) are lifted a few meters with polygon offset. Shaders are precompiled at start (`renderer.compile`).
  - **Rendering lessons (don't regress):** no `logarithmicDepthBuffer` (it mis-sorted big ground triangles and drew the ground over the rooftop); no giant triangles near the viewer (the horizon is a `RingGeometry` starting 34 km out, not a disc; long strips are segmented); no `PMREMGenerator`/`scene.environment` (it broke the rest of the scene; glass uses Phong specular + emissive instead). **Headless Chrome's SwiftShader flickers this scene** (rooftop vanishing in alternating eyes); for screenshots use `--use-angle=d3d11`, which renders correctly. Fixed 80° horizontal FOV (`VR_HFOV_DEG`); the HUD uses the same FOV, and in VR `currentHeading()` comes from the rendered view, so compass icons sit exactly on the 3D aircraft.
  - **Head tracking:** `orientation.getRotation()` (device→ENU matrix) → camera basis using `screen.orientation.angle` (landscape in the headset) → declination-corrected → slerp-smoothed. Desktop dev mode: arrow keys turn and look up/down.
  - **Aircraft:** built from primitives (no model files), airline tail colors, nav lights/strobes, rotor spin, bank from turn rate, pitch from climb rate, scaled with distance to stay visible (`TRUE_SCALE_RANGE_M` = 220 m, `MIN_SCALE` 1.5x), status-colored halos (focused = yellow), 45 s trails.
  - **Scene:** golden-hour `Sky` with clouds (sun 11° up, WSW), warm sun + sky fill light, lush vertex-colored ground, ~9,000 instanced low-poly trees, highways (Downtown Connector, I-20, I-285 ring), ATL's five runways (approximate positions) with approach lights, terminals, tower, glass towers (downtown/midtown/Buckhead) and warm low-rise sprawl, Grady helipad, and a Georgia Tech rooftop (gold railing) the viewer stands on. Matte surfaces use Lambert.
  - **Freeze planes** (start-screen checkbox, `freezePlanes`, **default on**): `main.ts` keeps the first non-empty set of aircraft and stops the feed, so the scene is still (lights still blink, rotors spin). Works with any data mode; untick it for live AR.
  - **Simulated scenario** (`scenario.ts`, data mode `sim`): fake, looping, deterministic. Starts 90 s in (`SIM_START_S`) so the frozen moment already has the emergency declared. Two arrival streams on 26R/27L (DAL1776 declares a 7700 emergency 30% into its route), westbound departures, a departure turning north past campus, a 35,000 ft overflight nearly overhead, a C-17 low pass 3 km north (military), a Life Flight H145 into Grady (medical), a Cessna circling PDK. Emits the normal `Plane` shape, so HUD, radar, cards, Grok and casting work unchanged.
  - **Casting in VR** uses the eye-0 VR canvas as the background.
- **Casting (spectator view / demo recording):** check **Cast to laptop** on the phone's start screen, then open **`http://localhost:5173/cast.html`** on the laptop running the dev server. The phone composites a single-eye 960×720 frame (camera + the same `drawHud()` + crosshair, 24 fps, its own FOV for the 4:3 frame) and sends it over **WebRTC, peer-to-peer**; only the offer/answer goes through the dev server (`/api/cast/offer`, `/api/cast/answer`, in-memory, latest offer wins), so video doesn't use ngrok bandwidth. Non-trickle ICE, public Google STUN, no TURN: phone and laptop must be able to reach each other (same Wi-Fi without client isolation). The viewer auto-reconnects, has **Record** (saves a `.webm`; `R` key), Fullscreen, and `H` to hide the bar. Encoder is set to `contentHint='detail'` + `maintain-resolution` so HUD text stays sharp. Fallback if the network blocks peer-to-peer: mirror the phone over USB with `scrcpy`. Cast status shows in the calibration **info** line.
- **HUD rule:** anything drawn on the overlay must be drawn identically in **both** eyes, or it won't fuse (text shown to one eye only flickers and is hard to read).
- **Exiting:** **long-press (1.5 s)** returns to the start screen. Leaving fullscreen (often an accidental back-swipe from the headset edge) does *not* exit the view: a "tap to resume" hint appears and the next tap re-enters fullscreen. The back gesture is swallowed while in the view.

## Voice service notes

Status, decisions, gotchas, and the browser-module plan for the voice workstream live in [`voice-service/CLAUDE.md`](voice-service/CLAUDE.md). Read that before touching `voice-service/` or `web/src/voice/`. Headline: the LLM behind `/api/voice/ask` is now **Grok** (`grok-4.3` via `https://api.x.ai/v1`, `XAI_REASONING_EFFORT=none` for ~0.9 s answers; `grok-4-fast` was retired by xAI on 2026-05-15). The provider is swappable via env vars (Gemini still works: leave `XAI_REASONING_EFFORT` unset) and the contract is unchanged.
