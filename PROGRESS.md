# Bombirdier progress

Full plan: [docs/bombirdier-plan.md](docs/bombirdier-plan.md). Each phase also has a GitHub milestone and a tracking issue; tick boxes here as work lands and close the issue when the phase's "Done when" is met.

Legend: ⬜ not started · 🟡 in progress · ✅ done

| Phase | Status | Tracking issue |
|---|---|---|
| 0. Sky-placement patch + rename | 🟡 | [#1](https://github.com/KNQuoc/Bombirdier/issues/1) |
| 1. Live traffic to 250 nm + list view | 🟡 | [#2](https://github.com/KNQuoc/Bombirdier/issues/2) |
| 2. Traffic-pattern overlay at 1G0 | 🟡 | [#3](https://github.com/KNQuoc/Bombirdier/issues/3) |
| 3. AI voice assistant (Mac server + Aivana) | 🟡 | [#4](https://github.com/KNQuoc/Bombirdier/issues/4) |
| 4. Radio-call linking (LiveATC) | ⬜ | [#5](https://github.com/KNQuoc/Bombirdier/issues/5) |
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
- [x] Active runway setting (default 28)
- [x] `src/pattern/geometry.ts`: pattern legs as lines (0.75 nm offset and extensions; level at TPA, then 800 ft AGL turning base, 500 ft turning final)
- [x] `src/pattern/classify.ts` with hysteresis (a new leg has to win 2 checks, 2 s apart) + unit tests (one plane per leg, exclusions, runway 10 mirror, tracker)
- [x] Radar: runways, dashed pattern, leg labels (DW, B, F, UW, XW); near the field it zooms to 5 km so the pattern is visible, with faint rim dots for traffic beyond
- [x] Card: "Right downwind · RWY 28" (also in a plane opened from the list)
- [x] Stretch: pattern drawn in the sky as a dashed line
- [x] Fallback viewer altitude corrected to an ellipsoid height (171 m, was 205 m MSL), so near objects like the pattern sit at the right angle before GPS altitude arrives
- [ ] Tune the classifier's numbers on live pattern traffic (so far checked only with hand-placed planes; no one was in the pattern at 23:00)
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
- [ ] On the phone: head-tilt trigger, microphone recording, speech playback (none of this has run on a device yet)
- [x] Voice chosen by Kien: `af_heart` (US female), which is the default
- [ ] Done: "what's that plane?" answered in < ~3 s (0.8 s on the Mac with test audio; phone not measured); "show me all the jets above thirty thousand feet" opens the filtered list (works, about 3–6 s through Aivana)

## Phase 4: radio-call linking (LiveATC)

- [ ] `mac-server/feeds.json` (Kien pastes the KTOL `streamUrl` by hand)
- [ ] Feed worker: ffmpeg decode → call splitting → Whisper → parse → ring buffer; idle stop after ~2 min
- [ ] Feed health: `GET /api/feeds`, `POST /api/feeds/{id}/check`
- [ ] `POST /api/radio/context`
- [ ] `mac-server/radio_parse.py`: phonetics, numbers, GA tails, airline radio names, position reports
- [ ] `GET /api/radio/events`, `GET /api/radio/heard`
- [ ] Phone: polling, matching (exact + GA suffix, near + wide traffic), highlight + subtitle
- [ ] Done: Toledo Approach calls appear within a few seconds and mostly match the right plane

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

- 2026-11-20 · phase 3 · Voice assistant built: Mac server (Whisper, instant rules, Aivana, Kokoro voice), phone side (head-tilt, recording, actions, playback), access checks. Verified on the Mac with real audio and in desktop dev mode; not yet on a phone.
- 2026-11-20 · phase 3 prep · Read Aivana's API docs and summarized them in `docs/aivana.md`; added `mac-server/.env.example`.
- 2026-11-20 · phase 2 · Wood County runways and traffic pattern on the radar and in the sky; pattern-leg classifier with hysteresis; leg on the card and radar; Active runway setting. 20 unit tests pass. Drawing checked with synthetic planes only: no live pattern traffic at night.
- 2026-11-20 · phase 1 · BGSU planes are tagged, colored orange and filterable; trainer type names added (P28A = Piper PA-28 Archer, PA44 = Piper PA-44 Seminole). Checked on a live BGSU Archer (N337BG) 25 km west of 1G0.
- 2026-11-20 · data check · adsb.lol vs adsb.fi over 250 nm: 410 shared planes, positions within ~100 m (median), altitudes within 50 ft, callsigns identical.
- 2026-11-20 · phase 1 · Two-speed traffic (50 km AR feed + 250 nm wide feed), list view with filters/sorting/paging/open-plane, ☰ button, wider radar, on-demand routes from adsb.lol route files. Verified in desktop dev mode on live traffic; APK builds. Phone and daytime checks open.
- 2026-11-20 · phase 0 · Android build set up on the Mac (Homebrew `openjdk@21` + `android-commandlinetools`, SDK platform 36); `gradlew` made executable; debug APK builds. Not yet installed on a phone.
- 2026-11-20 · phase 0 · Sky-placement patch applied as written; app renamed to Bombirdier; type checks and TS/Python parity pass; verified in desktop dev mode on live traffic near 1G0. APK build and outdoor test still open.
- 2026-11-20 · setup · Repo created from SkyLens (history squashed to one initial commit; local `upstream` remote points at jaiden-lee/ar-plane-identifier). Plan and tracker added.
