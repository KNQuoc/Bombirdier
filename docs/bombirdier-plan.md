# Bombirdier: build plan

**What Bombirdier is:** the SkyLens Android app (phone in a Google Cardboard) turned into an **AR aviation companion for aviation students and plane fans** at **Wood County Regional Airport (1G0)** in Bowling Green, OH, home of the BGSU flight program. On top of what SkyLens already does (identify planes in the sky with a compass "headband" and info cards), it adds:

1. **Sky placement.** Each plane gets a bracket at its real spot in the sky (direction + altitude). *Already written: see Phase 0.*
2. **Live traffic out to 250 nm + list view.** Live is the default (no scripted or test mode). The AR view shows planes within **50 km**. A compact **list view** covers every plane within **250 nm**, with filters and sorting, driven mainly **by voice**, plus one small button.
3. **Traffic-pattern overlay.** The runway and pattern on the radar (and later in the sky), with each plane labeled by leg: upwind, crosswind, downwind, base, final.
4. **AI voice assistant.** Ask questions or give commands out loud. Audio goes to a server on Kien's Mac: local Whisper transcribes it, then the **Aivana** API answers or takes the action.
5. **Radio-call linking.** Transcribe live ATC audio from **LiveATC** (Toledo Approach) and highlight the plane being talked about.
6. **Controllers on the headband + live ATC access.** Controller icons (Toledo Approach, Wood County CTAF) on the compass, showing whether a LiveATC feed is online. Point at a plane to see which frequency it's probably on and whether it was heard recently. Point at a controller and say "Can I access?" to hear the live audio, with a scrolling transcript.

One developer (Kien) building with Claude Code. Do the phases in order: each one leaves the app working.

---

## 0. Read first: how the existing repo works

Read the repo's `CLAUDE.md` and `app/android/README.md` before changing anything. Key facts:

- **The Android app is Capacitor.** It's TypeScript running in an Android WebView, in `app/android/src/`, with a small amount of Java in `app/android/native/`. It reuses `web/src/*` (HUD, geometry, stereo view, orientation) through the `@web` alias.
- **Plane data goes through one interface:** `PlaneFeed { get(): { planes, status }, stop() }` (`web/src/planes.ts`). The HUD doesn't care where planes come from. The live feed is `app/android/src/flights/feed.ts`, created in `startTracking()` in `app/android/src/main.ts`.
- **Live data comes from adsb.lol**, polled every 5–30 s (it rate-limits). Between polls, planes are moved along their track (dead reckoning).
- **The HUD** is `web/src/hud.ts`, drawn once per eye per frame. It has the compass bar, aircraft icons, the info card, the radar mini-map (`drawRadar`) and voice subtitles (`drawVoice`).
- **`fetch()` on the phone goes through native HTTP** (`CapacitorHttp` in `capacitor.config.ts`), so CORS and mixed content don't apply to `fetch`. `EventSource` and `WebSocket` are **not** patched, so use fetch polling for anything streaming from the Mac.
- **The Android app currently has no voice** (`voice: null` in `main.ts`). The web version's voice code (`web/src/voice/`) uses browser `SpeechRecognition`, which doesn't exist in an Android WebView. Phase 3 replaces it.
- **The data request is already capped at 250 nm** (`MAX_RADIUS_NM = 250` in `app/android/src/flights/adsb.ts`), which is adsb.lol's limit for one radius query. The settings screen caps the radius at 400 km (`parseRadius` in `main.ts`).
- **Route lookups (origin → destination) currently run for every plane received** (`lookupRoutes` / `applyRoutes` in `flights/nearby.ts`). Fine for 20 km. Not fine for 250 nm (Phase 1 changes this).
- `web/src/vr/scenario.ts` is a scripted Atlanta demo from the original hackathon. **Bombirdier doesn't use scripted traffic:** live is the only data source. Leave that file alone.

### Conventions (keep them)

- Degrees, bearings clockwise from **true** north, `[0, 360)`. Distance in km, altitude in feet, speed in knots.
- **Change `web/src/*` only in backward-compatible ways.** The web app must still build and behave the same. New `HudState` fields must be optional.
- If you change plane normalization, change **both** `app/android/src/flights/normalize.ts` and `flight-service/app/normalize.py`, then run `npm run check`.
- Put new Bombirdier-only code under `app/android/src/` (e.g. `src/traffic/`, `src/list/`, `src/pattern/`, `src/voice/`, `src/radio/`, `src/atc/`), plus a new `mac-server/` folder at the repo root.
- Add a short "Bombirdier" section to the root `CLAUDE.md` describing the new pieces as you build them.

### Checks after every phase

```sh
cd app/android && npx tsc -p . && npm run check   # Android types + TS/Python flight parity
cd ../../web && npx tsc -p .                      # web app still compiles
```

Desktop testing: `cd app/android && npm run dev`, then open `http://localhost:5174/?dev=1`. Arrow keys turn left/right; up/down tilt (added in Phase 0).

---

## Phase 0: apply the sky-placement patch and rename

1. In a fresh clone of the repo: `git apply sky-placement.patch`. Kien has the file. It adds:
   - `projectSky()` and `elevationDeg()` in `web/src/geo.ts` (full pinhole projection with pitch; Earth curvature included)
   - `Plane.altitudeGeomFt` (ADS-B `alt_geom`), in both normalizers
   - GPS altitude kept as `LatLon.altM`
   - altitude extrapolated with vertical rate between polls
   - HUD: corner brackets on planes at their sky position when `HudState.pitchDeg` and `viewerAltM` are passed; focus picked by true angle from the view center; the card follows the focused bracket
   - Android passes pitch + viewer altitude (GPS, else `FALLBACK_GROUND_M = 205` + `EYE_HEIGHT_M = 1.75`); up/down arrows set pitch in dev mode
2. Run the checks above.
3. Change the app's display name to **Bombirdier** (`appName` in `capacitor.config.ts`, then `npm run sync`). Leave `appId` alone: changing it would install a second app and lose compass calibration.
4. **Done when:** the APK builds, and outdoors the brackets land on real planes. Expect the height to be accurate and left/right to be off by a few degrees (compass).

---

## Phase 1: live traffic out to 250 nm + list view

**Goal:** live is the default and only data source. The AR view (sky brackets, compass icons, focus card) shows planes within **50 km**. A compact **list view** shows **every plane within 250 nm**, which in daytime is likely 1,000+ around Bowling Green. Voice control of the list arrives with Phase 3. This phase builds the list, its filter model and one small button.

### Two-speed data: `app/android/src/traffic/`

- **Near feed (AR):** what exists today (`flights/feed.ts`): adsb.lol `/v2/point` around the GPS position, radius = **AR radius (default 50 km)**, adaptive 5–30 s polling, dead reckoning between polls. Only these planes go to the HUD.
- **Wide feed (list + radar):** a second poller, radius **250 nm** (adsb.lol's max per request), every **~60 s**. It shares the near feed's 429/slow-answer backoff (one adsb.lol rate limit for both), so the wide poll waits whenever the near one is throttled. Merge by plane `id`: near data wins (it's fresher).
- A 250 nm response can be large (likely 1 MB+ in daytime; measure it). Add a setting **"Wide traffic: on / Wi-Fi only / off"**, defaulting to on.
- Distances and bearings for wide planes: recompute from the current GPS position when the list is drawn, not every frame. Dead-reckon wide planes only when the list is open (cheap at 60 s granularity).
- **Settings:** replace "Search radius" with **AR radius (km)**, default 50, max 100. The wide radius is fixed at 250 nm.

### Route lookups on demand

Change `nearby.ts` so routes are looked up **only** for:
- planes in the near feed (≤ ~50 km), and
- a plane opened from the list or focused by voice.

Never look up the whole 250 nm set: that would send a thousand callsigns to the route service.

### List view: `app/android/src/list/`

- **Drawn on the HUD canvas in both eyes**, like everything else, so it works inside the Cardboard. A semi-transparent panel on the right ~40% of each eye. The radar stays on the left. Keep it light: no heavy borders, small text, the camera view stays visible behind it.
- **Header:** `1,243 planes · 250 nm · 40s ago` plus the active filters as small chips (`✈ jets · >30,000 ft · SWA`).
- **Rows (8 per page):** callsign/registration · type · altitude · distance · a small direction arrow relative to where you're facing. `below horizon` if its elevation angle (from `elevationDeg`, Phase 0) is under 0°. Status colors as on the compass (emergency red, medical purple, military green).
- **Filter model (`ListFilter`, plain JSON so voice can set it later):**
  - `kind`: jets / props / helicopters / military / medical / emergencies
  - `airline` (ICAO code, e.g. `SWA`)
  - `typeCode` (e.g. `B738`)
  - `minAltFt`, `maxAltFt`, `minDistNm`, `maxDistNm`
  - `climbing` / `descending`
  - `onGround` (default: hide)
  - `query` (callsign / registration substring)
  - `sort`: distance / altitude / speed, asc or desc
  - `page`
- **Opening a plane:** shows its full card (with route, looked up on demand). If it's within the AR radius, its bracket pulses and the compass shows an arrow toward it. If it's farther away: "312 km west-northwest · below horizon".
- **The small button:** one small round icon (e.g. a `☰` list glyph) in the top-right corner **next to the existing ⚙**, outside the eye images, same size as ⚙. Tap = list on/off. That's it: no other on-screen controls. With the phone in the headset, voice (Phase 3) is the way in. With the phone in hand, tapping a row opens it, and a swipe or the panel's ▲▼ pages.
- **Dev mode:** `L` toggles the list, `PageUp`/`PageDown` pages, `F` cycles a few preset filters, so the list can be built before voice exists.

### Radar

- Extend `RADAR_RANGES_KM` (`web/src/hud.ts`, currently max 120 km) up to 463 km (250 nm) with steps like 160, 240, 320, 463.
- Default radar = AR planes (auto range, as today). While the list is open, the radar shows the **filtered list's** planes at a range that fits them.
- Add optional `HudState.radarRangeKm` (manual override) for voice ("zoom the radar to 100 miles").

**Done when:** the list shows hundreds of planes in daytime, filters and sorting work from dev keys and the ☰ button, the AR view still only draws planes within 50 km, and the route service is only called for near and opened planes.

---

## Phase 2: traffic-pattern overlay at Wood County (1G0)

### Airport data: `app/android/src/airports/1g0.ts`

Coordinates are runway thresholds from OurAirports (`runways.csv`), with true headings. Pattern directions are from third-party airport data, so double-check them against the FAA Chart Supplement before relying on them.

| | Value |
|---|---|
| Field elevation | 673 ft (205 m) |
| Traffic pattern altitude (TPA) | 1,700 ft MSL (1,027 AGL) |
| Runway 10/28 | 4,199 × 75 ft. **10** threshold 41.39180, −83.63520 (091° true). **28** threshold 41.39160, −83.61990 (271° true) |
| Runway 18/36 | 2,628 × 50 ft. **18** threshold 41.39340, −83.63430 (179° true). **36** threshold 41.38620, −83.63420 (359° true; 57 ft displaced threshold) |
| Pattern direction | **10 left, 28 right** (both put the pattern north of 10/28). **18 left, 36 right** (both east of 18/36) |
| Calm-wind runway | 28 |
| Non-towered | CTAF/UNICOM **122.975**. Toledo Approach/Departure **126.1**. AWOS **120.725** |

Model it as: `Airport { ident, elevationFt, tpaFtMsl, runways: RunwayEnd[] }`, where `RunwayEnd { ident, threshold: LatLon, headingTrue, patternSide: 'left' | 'right', oppositeIdent }`.

Add an **Active runway** setting (default 28). The assistant can change it by voice in Phase 3.

### Geometry: `app/android/src/pattern/geometry.ts`

From an active `RunwayEnd`, build the standard rectangle:

- **Downwind** offset to the `patternSide`, ~0.75 nm (1.4 km) from the runway centerline, parallel to it
- **Crosswind** and **base** turns ~0.75 nm past each runway end
- All at TPA
- **Final** descends from TPA at the base-to-final turn down to the threshold
- **Upwind** climbs from the threshold to TPA

Export the legs as polylines (lat/lon + altitude) for drawing.

### Classifier: `app/android/src/pattern/classify.ts`

`classify(plane, airport, activeRunway) → { leg: 'upwind' | 'crosswind' | 'downwind' | 'base' | 'final' | 'departure' | 'entry' | null, confidence }`.

- Only planes within ~6 km of the field, between the ground and ~TPA + 700 ft, and not on the ground.
- Transform the plane's position into runway coordinates (along-track, cross-track) and its track into a runway-relative angle. Then use rules. Example: cross-track on the pattern side, ~0.5–2 km out, track roughly opposite the runway heading ⇒ downwind.
- **Hysteresis:** keep a per-plane last leg and switch only after the new leg wins 2 checks in a row. Live data is 5–30 s old and dead-reckoned straight ahead, so labels will otherwise jump at turns.
- **Tune on live traffic** at Wood County. A handful of small unit tests with hand-made positions (one per leg) is enough. No scripted traffic.

### Drawing

- **Radar (`drawRadar` in `web/src/hud.ts`):** add optional `HudState.airport` data (the runway line or lines, plus the active pattern polyline). Draw the runway as a thick line and the pattern as a dashed rectangle, in the radar's heading-up frame. Next to each plane dot in the pattern, a tiny leg label (`DW`, `B`, `F`, `UW`, `XW`).
- **Info card:** add a line like `Right downwind · RWY 28` when the classifier has a leg (`cardLines` in `web/src/format.ts`, or an Android-side wrapper).
- **Stretch, pattern in the sky:** with `projectSky()` from Phase 0, project points along each pattern leg at TPA and draw them as a faint dashed line over the camera view. That draws the actual traffic pattern in the sky.
- **Done when:** standing near Wood County on a flight-school day, the radar shows the runway and pattern, BGSU planes in the circuit get the right leg most of the time, and the card shows it.

---

## Phase 3: AI voice assistant (Mac server + Aivana)

### Architecture

```
Phone (Bombirdier app)                         Kien's Mac (M5 Pro): mac-server/ (FastAPI)
  head-tilt → record audio (MediaRecorder)  ──►  POST /api/voice/ask  { audio (base64), context }
  shows transcript + answer in drawVoice          → mlx-whisper (whisper-large-v3-turbo) → text
  speaks answer with Android native TTS     ◄──   → Aivana LLM (assistant prompt + plane/airport context)
                                                  ← { transcript, answer }
```

### Connecting the phone to the Mac

- **USB (preferred):** `adb reverse tcp:8787 tcp:8787`, then the app calls `http://localhost:8787`. No network setup needed. Re-run it after reconnecting the cable.
- **Wi-Fi:** add a **Server URL** field in settings (e.g. `http://192.168.1.23:8787`). Android blocks plain HTTP by default, so add a network security config allowing cleartext traffic (fine for a personal project), referenced from `AndroidManifest.xml`.
- Use `fetch()` (native HTTP via CapacitorHttp). Send audio as **base64 in JSON**, not multipart/Blob, which is unreliable through the native bridge.
- `GET /api/health` on the Mac. Show server status in the info/debug line.

### Phone side: `app/android/src/voice/`

- **Activation: head-tilt push-to-talk.** You can't tap the screen while it's in the Cardboard. Tilting the head sideways (roll > ~30°) for ~0.8 s starts recording, with a short beep and the HUD's "listening" state. Recording stops after ~1.3 s of silence (Web Audio analyser level) or 10 s max. `web/src/orientation.ts` doesn't expose roll yet: add `rollDeg` to `OrientationReading`, computed from the same rotation matrix (backward compatible).
- Add the `RECORD_AUDIO` permission to `AndroidManifest.xml`, and request it at start along with camera/location.
- Record with `MediaRecorder` (webm/opus) from `getUserMedia({ audio: true })`.
- **Context sent with each question:** the focused plane (full `Plane`), up to 5 other planes in view (callsign, type, altitude, distance, pattern leg), the active runway, airport info, and the **list state** (open or closed, current filter, visible rows).
- **Speaking the answer:** use Android's native TTS via a Capacitor plugin (`@capacitor-community/text-to-speech`). WebView `speechSynthesis` is unreliable on Android.
- Turn the HUD voice display back on: pass a `VoiceHud` into `HudState.voice` in `main.ts`. The subtitle drawing (`drawVoice`) already exists.

### Mac side: `mac-server/`

- FastAPI with uvicorn, port 8787. `requirements.txt`: `fastapi`, `uvicorn`, `mlx-whisper`, `httpx`. `ffmpeg` installed with Homebrew (for decoding webm).
- Transcribe with `mlx-whisper` using `whisper-large-v3-turbo`. Pass an `initial_prompt` with aviation vocabulary and the callsigns currently in view: it helps Whisper spell them right.
- **LLM adapter `mac-server/llm.py`:** a single `async def complete(messages) -> str`. **Kien will add Aivana's API docs to `docs/aivana.md`.** Implement against those. If Aivana is OpenAI-compatible, use the `openai` SDK with `base_url`. Config from `.env`: `AIVANA_API_KEY`, `AIVANA_BASE_URL`, `AIVANA_MODEL`. Never put the key in the app.
- **Prompt:** start from the system prompt in `voice-service/main.py` (remove the Grok references). Persona: a **hands-free AI voice assistant** in the headset, like a knowledgeable co-pilot, **not a teacher**. Answer the question directly in short spoken answers (1–2 sentences, 3 max). No quizzing, no lessons, no "great question". Explain only when asked ("why?"). It knows the planes around you, the 250 nm traffic, the airport, the pattern and (Phase 5) the radio feeds, and it can take actions through tools (list filters, radar zoom, radio feeds).

### Voice control of the list and radar

- **Tools** (`mac-server/tools.py`, shared with Phase 5):
  - `show_list(filter?)`, `hide_list()`
  - `set_filter(partial ListFilter)`, `clear_filter()`, `sort(by, order)`, `page(next | prev)`
  - `open_plane(query)`: callsign/registration/airline + number, or a row number ("open number 3")
  - `radar_range(nm)`
  - `count(filter)`: answers "how many Southwest flights are around?" without opening the list
- The server returns `{ answer, actions: [...] }`. The phone applies the actions (it owns the list and HUD state), then speaks `answer`.
- **If Aivana supports tool/function calling** (check `docs/aivana.md`), use it. **If not**, ask Aivana for a strict JSON reply `{ "answer": "...", "actions": [...] }` (JSON mode if available). Validate it against the `ListFilter` schema and drop anything invalid.
- **Examples it should handle:**
  - "Show me all the helicopters." → `show_list({kind:'helicopters'})`
  - "Only Southwest above thirty thousand." → `set_filter({airline:'SWA', minAltFt:30000})`
  - "Sort by altitude." / "Next page." / "Open number three." / "Clear filters." / "Close the list."
  - "Any emergencies within 250 miles?" → `count` + speak the answer, open the list if there are any.
  - "Zoom the radar out to 100 miles."
- Keep replies to one short sentence for list actions ("Twelve helicopters, closest is 18 miles north.").

- **Done when:** with USB connected, you tilt your head, ask "what's that plane?" and hear a correct answer in under ~3 s, and "show me all the jets above thirty thousand feet" opens the list with that filter.

---

## Phase 4: radio-call linking (LiveATC)

**Goal:** when a radio call names a plane ("Delta eighteen thirty, descend and maintain four thousand"), the app highlights that plane for a few seconds and shows the call as a subtitle.

### Feeds: `mac-server/feeds.json`

Every audio source is a **feed** with an id, so later phases can say "connect to feed X". All feeds go through the same pipeline (decode → split into calls → Whisper → parse).

```json
[
  { "id": "tol-app", "kind": "liveatc", "name": "Toledo Approach (LiveATC)", "freqs": ["126.1", "134.35"],
    "streamUrl": "<Kien pastes the stream URL here>" }
]
```

- **Kien fills in `streamUrl` by hand.** On liveatc.net, find the KTOL (Toledo) feed. Its "listen" link downloads a small `.pls` playlist file, and the `File1=` line inside is the direct stream URL. **Don't guess or scrape URLs, and don't hardcode one in code.** LiveATC has no public API.
- **Personal use only.** LiveATC's site says third-party use of its live streams is prohibited. Kien has decided to use it privately anyway. Keep it simple and polite: one connection per feed, only while it's in use (an app session is open, or someone asked for that feed), reconnect at most every 30 s on failure, set a clear `User-Agent` (`Bombirdier/0.1 (personal project)`), no redistribution, no recording kept to disk by default.
- Reported by a LiveATC listener in 2023: the KTOL feed carries Toledo Approach (East 126.1, West 134.35) and seemed to have **only the controller's side**. Design for that: controllers say the callsign in every call, so matching still works.

### Audio sources (on the Mac)

1. **LiveATC stream (feed `tol-app`):** `ffmpeg -i <streamUrl> -f s16le -ac 1 -ar 16000 -` decodes the stream into raw 16 kHz mono audio for the splitter. It's a **live stream**: keep only a short rolling buffer (~60 s) in memory for cutting out calls and for re-serving audio to the phone. Expect it to run some seconds behind real time.
2. **Stretch (Phase 6):** an RTL-SDR dongle for Wood County CTAF (122.975), which LiveATC doesn't cover.

### Server

- **One worker per active feed** (asyncio task): reads audio → splits it into individual calls on silence (energy threshold, or Silero VAD) → transcribes each with mlx-whisper → parses it → appends an event to that feed's ring buffer (last ~200 calls). Start a feed's worker when it's first needed. Stop it after ~2 min with nobody using it.
- **Feed health:** per feed, `status` = `online` (audio arrived in the last ~15 s) / `connecting` / `offline` (stream won't connect or ends) / `idle` (not running), plus `lastCallAt`. `GET /api/feeds` returns all feeds with status. `POST /api/feeds/{id}/check` tries a quick connect (~5 s) without starting a full worker, so the headband can show status for feeds nobody is listening to.
- Use an aviation-vocabulary `initial_prompt` for Whisper, plus the callsigns currently around: the phone sends its plane list every few seconds with `POST /api/radio/context`.
- **Parser `mac-server/radio_parse.py`:**
  - Phonetic alphabet and spoken numbers → characters ("niner zero one bravo golf" → `901BG`, "November one two three alpha bravo" → `N123AB`).
  - Callsign patterns:
    - type + tail ("Archer 901BG", "Seminole 905BG", "Skyhawk …")
    - "November" + full registration
    - airline radio name + flight number ("Delta eighteen thirty" → `DAL1830`), using a hand-maintained radio-name table: Delta→DAL, American→AAL, United→UAL, Southwest→SWA, Speedbird→BAW, Brickyard→RPA, Blue Streak→JIA, Endeavor→EDV, Envoy→ENY, Skywest→SKW, FedEx→FDX, plus whatever shows up near Toledo
  - Position reports: "<left|right> <upwind|crosswind|downwind|base|final> runway <NN>" (mostly heard on Wood County's own frequency, so this pays off with the Phase 6 dongle).
- Exposes `GET /api/radio/events?feed=<id>&since=<eventId>` → `{ events: [{ id, feedId, ts, text, callsignTokens, reportedLeg?, runway? }] }` (`feed` optional = all active feeds). The phone **polls** this every ~500 ms (no SSE or WebSocket: see Phase 0 notes on CapacitorHttp).
- Also keep a per-feed index of **callsigns heard** (normalized callsign → last time heard + event id), for Phase 5's "was this plane heard?" check: `GET /api/radio/heard?callsign=DAL1830` → `{ feedId, lastHeardAt, eventId } | null`.

### Phone

- Matching happens on the phone, since it has the plane list. Exact match on `callsign` or `registration`. Otherwise, a GA suffix match: the last 3 characters of the registration ("1BG"), which is how pilots shorten calls after the first one. Ties go to the closer plane.
- **Highlight:** a pulsing ring on the plane's sky bracket and compass icon for ~8 s, plus a subtitle line `📻 DAL1830: descend and maintain 4,000`. If the plane is beyond the AR radius, the subtitle says where it is ("62 km NW").
- If the call reports a leg, show it next to the classifier's leg on the card. Showing both makes a mismatch visible.
- Matching also checks the **wide (250 nm) traffic**, since Toledo Approach talks to planes outside the 50 km AR radius.
- **Done when:** with the `tol-app` feed live, Toledo Approach calls show as subtitles within a few seconds of the audio, and most calls that name a plane match the right one (spot-check against the list view).

---

## Phase 5: controllers on the headband + live ATC access ("Can I access?")

**Goal:** controllers appear on the headband like planes do. Pointing at a plane tells you which frequency it's probably on and whether it's been heard. Pointing at a controller and saying "Can I access?" connects you to that frequency's live audio and transcript.

### Facilities: `app/android/src/atc/facilities.ts`

A small hand-made list. Positions are where the icon sits on the headband: the controller's airport or radar site.

| id | Name | Position | Frequencies | Feed |
|---|---|---|---|---|
| `tol-app` | Toledo Approach | Toledo Express (KTOL) 41.58682, −83.80783 | 126.1 (sector 360°–179° from TOL), 134.35 (180°–359°) | `tol-app` (LiveATC) |
| `1g0-ctaf` | Wood County CTAF | 1G0 41.39100, −83.63010 | 122.975 | none yet (RTL-SDR in Phase 6) |

Add more later (Toledo Tower 118.1, Cleveland Center) only if a feed exists for them.

### "Who's this plane probably talking to?": `app/android/src/atc/whoControls.ts`

ADS-B doesn't say which frequency a plane is tuned to, so **guess from position, then confirm from transcripts**:

1. On the ground at 1G0, or within ~5 km of 1G0 below ~3,000 ft MSL → `1g0-ctaf`.
2. Else within ~40 nm of KTOL and below ~10,000 ft → `tol-app`. Sector frequency from the bearing from KTOL to the plane (126.1 for 360°–179°, 134.35 for 180°–359°). Bowling Green is southeast of Toledo, so 126.1.
3. Else → "Cleveland Center (no feed)".

The boundaries are rough approximations of real airspace. Label the result **"likely"** in the UI.

**Confirm:** if `GET /api/radio/heard` finds the callsign, show "✅ heard on Toledo Approach 40 s ago". That's evidence, not a guess.

### Headband and card

- **Controller icons** on the compass bar at their bearing (a small tower/antenna icon, different from aircraft), with a **status dot**: 🟢 feed online, 🟡 connecting, 🔴 feed offline, ⚪ no feed. The phone refreshes feed status from `GET /api/feeds` every ~10 s. When an icon comes into view, it triggers `POST /api/feeds/{id}/check` at most once a minute per feed.
- **Focus works on controllers too.** The focus logic picks whatever is nearest the view center within the focus cone: plane or controller. Controller icons live only on the compass bar (no sky bracket).
- **Controller card:** name, frequencies, feed status, the last call heard (if any), and the hint "Say *'Can I access?'*".
- **Plane card** gets a radio line: `📻 Likely Toledo Approach 126.1 · ✅ heard 40s ago`, or `📻 Wood County CTAF 122.975 · no live feed`.

### "Can I access?" voice flow (the assistant, through Aivana)

- The phone sends the voice question (Phase 3) with extra context: the focused item (plane **or** facility), the frequency guess for a focused plane, feed statuses, and whether you're currently connected to a feed.
- **The assistant gets tools** (`mac-server/tools.py`):
  - `who_controls(plane)`
  - `feed_status(feed_id)`
  - `connect_feed(feed_id)`
  - `disconnect_feed()`
  - `recent_transcript(feed_id, n)`
  - `heard(callsign)`
  - `radio_audio(on | off | volume)`: mute, unmute or change the volume of the live ATC audio, **without disconnecting**
  - `transcript(show | hide)`: show or hide the scrolling transcript, **independent of the audio**

  If Aivana supports tool/function calling (check `docs/aivana.md`), let the model call them. **If it doesn't**, route with simple rules first ("access", "connect", "listen", "tune" → connect; "disconnect", "stop", "leave" → disconnect; "what did they say" → recent transcript), run the tool on the server, and give the result to Aivana to write the spoken reply.
- **Pointing at a controller:** "Can I access?" → if the feed is online: "Yes, Toledo Approach is live. Connecting." Then start the audio and transcript. If it's offline or has no feed: say so, and suggest an alternative (e.g. "No live feed for Wood County CTAF. Toledo Approach is live, want that instead?").
- **Pointing at a plane:** "Can I access?" / "Can I hear this one?" → use `who_controls` + `heard` → connect to that facility's feed if it has one, and say how sure it is ("It's probably on Toledo Approach, and I heard it there a minute ago. Connecting.").
- **While connected:** "What did they just say?", "What did they tell Delta?" (`recent_transcript`, then Aivana answers in plain English), "Who's on this frequency?" (callsigns heard in the last few minutes, matched to planes), "Disconnect."
- **Audio and transcript are separate switches**, each controllable by voice:

  | Say | Audio | Transcript | Feed connection |
  |---|---|---|---|
  | "Mute the radio" / "Mute Toledo" | off | unchanged | stays connected (transcription keeps running) |
  | "Unmute" / "Radio on" | on | unchanged | connected |
  | "Turn it down" / "Louder" | volume ∓ | unchanged | connected |
  | "Hide the transcript" | unchanged | hidden | connected |
  | "Show the transcript" | unchanged | shown | connected |
  | "Transcript only" | off | shown | connected |
  | "Audio only" | on | hidden | connected |
  | "Disconnect" | off | hidden | **disconnected** (worker stops after ~2 min idle) |

  Muted or hidden, the feed keeps transcribing, so radio-call highlights (Phase 4) and "heard" checks keep working. These are instant local actions on the phone. Simple keyword rules can handle them directly without waiting for Aivana, with a short confirmation ("Radio muted.").
- Remember the last audio/transcript choice per feed for the session (e.g. reconnecting to Toledo comes back muted if you'd muted it).

### Hearing the audio on the phone

- The Mac re-serves the live feed as an HTTP MP3 stream: `GET /api/feeds/{id}/audio` (from the worker's rolling buffer via `ffmpeg`, or a straight relay of the LiveATC stream). The phone plays it in an `<audio>` element.
- Over USB (`adb reverse`), `http://localhost:8787` works as-is. Over Wi-Fi, an `http://` LAN URL inside the app's `https://localhost` page counts as mixed content: set `android: { allowMixedContent: true }` in `capacitor.config.ts`, plus the cleartext network config from Phase 3.
- The assistant's spoken answers (native TTS) should **duck** the ATC audio: lower its volume while speaking, then restore it.

### Connected view (HUD)

- A "📻 Toledo Approach · LIVE" pill near the top, with small state icons: 🔇 when muted, 💬 when the transcript is shown. The last ~4 transcript lines scroll in the bottom area, in place of the radar while connected (the radar already steps aside for voice subtitles). Callsigns in the transcript are tinted when they match a plane in view.
- A transcript line that names a plane highlights it in the sky (Phase 4 highlight).
- **Done when:** pointing at the Toledo Approach icon shows a green dot. Saying "Can I access?" plays the live audio within ~5 s with a scrolling transcript. "Mute the radio" silences the audio while the transcript keeps scrolling, "hide the transcript" clears it from the HUD, and the reverse commands bring each back. Saying "Disconnect" stops it. Pointing at an airliner near Bowling Green shows "likely Toledo Approach", and after it's been called, "heard".

---

## Phase 6: stretch goals (only after 1–5 work)

- **RTL-SDR for Wood County CTAF:** a dongle plugged into the Mac, `rtl_fm -M am -f 122.975M -s 12k - | ffmpeg …` as another feed `1g0-ctaf-sdr`. Wood County's icon then gets a real live feed, and position reports from pattern traffic feed the Phase 2 leg cross-check.
- **Filters in the sky too:** "only show helicopters in the sky" applies the list filter to the AR view.
- **X-Plane mode:** a Mac relay reads X-Plane's UDP data (own position plus traffic) and serves it as JSON. A third data source, "Sim (X-Plane)", feeds the HUD through a new `PlaneFeed`.
- **Auto active runway:** pick it from the legs of observed traffic, or from KTDZ wind (nearest METAR, 12 nm).
- The pattern drawn in the sky (from Phase 2), if not done already.

---

## Known risks and what to do about them

| Risk | Mitigation |
|---|---|
| Compass off by a few degrees, so brackets sit beside planes | Use the existing compass calibration screen. Test outdoors away from cars and metal. Height placement is reliable because it comes from gravity. |
| Pattern legs jumping on live data (5–30 s updates) | Hysteresis. Show the leg only above a confidence threshold. |
| Whisper mishears callsigns | Prompt with current callsigns. Fuzzy suffix match. Highlight only on a confident match. |
| LiveATC feed down, changed or behind | Feed status on the headband. The assistant says when a feed is offline. Stream URL lives in `feeds.json`, so it's easy to replace. Expect a delay of some seconds. |
| LiveATC feed has only the controller's side | Matching works off the controller's calls. The plane card still says "heard" when the controller addresses it. |
| "Which frequency is this plane on" is a guess | Always labeled "likely" until the callsign is actually heard. |
| adsb.lol coverage at 1G0 | BGSU training planes (N3xxBG Archers and Seminoles) show up on FlightAware, which suggests they broadcast ADS-B. adsb.lol depends on volunteer receivers nearby, so check its map around 1G0 before relying on live data. |
| Phone can't reach the Mac | Prefer USB + `adb reverse`. Show server health in the info line. |
| 250 nm = 1,000+ planes: clutter, data use, rate limits | AR limited to 50 km. Wide poll every ~60 s with shared backoff. "Wide traffic: Wi-Fi only" setting. Routes only on demand. |
| adsb.lol caps one request at 250 nm | Fixed at 250 nm. Past ~230 nm even a jet at cruise is below the horizon, so nothing farther would be visible anyway. |
