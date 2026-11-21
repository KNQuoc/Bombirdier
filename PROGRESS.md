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
| 5. Controllers on headband + "Can I access?" | ⬜ | [#6](https://github.com/KNQuoc/Bombirdier/issues/6) |
| 6. Stretch goals | ⬜ | [#7](https://github.com/KNQuoc/Bombirdier/issues/7) |

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
- [ ] Real airline times (scheduled / actual departure and arrival): no free source found. adsb.lol has none, its flight-history pages refuse programs, and Aivana's web search found nothing live. Needs a flight-status API key if Kien wants them
- [ ] Head-tilt trigger in the headset: not confirmed yet (the two-finger tap was used)
- [x] Voice chosen by Kien: `af_heart` (US female), which is the default
- [ ] Done: "what's that plane?" answered in < ~3 s (0.8 s on the Mac with test audio; phone not measured); "show me all the jets above thirty thousand feet" opens the filtered list (works, about 3–6 s through Aivana)

## Phase 4: radio-call linking (LiveATC)

- [x] How the audio gets in (Kien's decision, 2026-11-21): **through a browser tab**. LiveATC only offers an in-browser player now and says streams may not be used in third-party products, so the server never connects to its streams. The feed plays in LiveATC's player in a Chrome tab; `http://localhost:8787/capture` shares that tab's sound with the server (`"kind": "tab"` in `feeds.json`, `POST /api/feeds/{id}/audio`)
- [x] `mac-server/feeds.json`: five feeds, each with its LiveATC page and name there (checked 2026-11-21): **Wood County CTAF** 122.975 (the one that matters most: BGSU pattern calls; the plan assumed LiveATC didn't cover it), **Toledo Tower and Approach** (one feed mixing 118.1, 126.1, 134.35, Ground and Clearance), **Detroit Approach (Arrival West)** 124.05, **Cleveland Center (Bluffton High)** 119.325, **Columbus Approach (North)** 125.95. The Detroit and Cleveland sectors are a guess from their names. Fort Wayne not looked up (LiveATC refused the lookup)
- [x] Phone follows every feed at once: all calls from the home frequency (first in `feeds.json`), and from the others only calls that name a plane the app knows
- [ ] First real capture: open a LiveATC tab, press Capture tab (the permission click is Kien's), and see whether it keeps going for an hour with the tabs in the background
- [x] Feed worker: ffmpeg decode → call splitting (`splitter.py`) → Whisper with a radio prompt → parse → ring buffer of 200; one connection per feed, started by the phone asking for calls, stopped 2 min after it last asked, reconnect at most every 30 s
- [x] Feed health: `GET /api/feeds`, `POST /api/feeds/{id}/check`
- [x] `POST /api/radio/context` (callsigns around, said the radio way, go into Whisper's prompt)
- [x] `mac-server/radio_parse.py`: phonetics, numbers, GA tails, airline radio names, position reports
- [x] `GET /api/radio/events`, `GET /api/radio/heard`
- [x] Phone (`src/radio/`): polling, matching (exact + tail suffix, near + wide traffic), pulsing highlight for 8 s + subtitle; where the plane is if it's outside the AR view; a leg said on the radio shown next to the classifier's on the card
- [x] Setting: Radio calls On / Off
- [x] Tests: 48 checks on the parser and splitter, a plane-matching test, and the whole pipeline run on test recordings (clean and radio-quality) including one that named real planes in the air: both were matched, one of them 116 km away
- [ ] Not yet heard on real ATC audio: the test recordings are a computer voice. Real controller audio is faster, clipped and noisier, and Whisper will do worse on it
- [ ] Done: Toledo Approach calls appear within a few seconds and mostly match the right plane (needs a real capture)

## Phase 5: controllers on headband + "Can I access?"

- [ ] `src/atc/facilities.ts` (Toledo Approach, Wood County CTAF)
- [ ] `src/atc/whoControls.ts` ("likely" guess + "heard" confirmation)
- [ ] Controller icons with status dots; feed status refresh + checks
- [ ] Focus on controllers; controller card; plane card radio line
- [ ] Assistant tools: who_controls, feed_status, connect/disconnect, recent_transcript, heard, radio_audio, transcript
- [ ] `GET /api/feeds/{id}/audio` MP3 relay; `<audio>` on phone; TTS ducking
- [ ] Connected view: LIVE pill, 🔇/💬 icons, scrolling transcript
- [ ] Separate audio/transcript switches, remembered per feed
- [ ] Done: "Can I access?" plays Toledo Approach within ~5 s; mute/hide/disconnect all work

## Phase 6: stretch goals

- [ ] RTL-SDR feed for Wood County CTAF (122.975)
- [ ] List filters applied to the sky view
- [ ] X-Plane mode
- [ ] Auto active runway
- [ ] Pattern in the sky (if not done in Phase 2)

---

## Log

Newest first. One line per meaningful change: date, phase, what landed.

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
