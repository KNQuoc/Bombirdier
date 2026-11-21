# Bombirdier progress

Full plan: [docs/bombirdier-plan.md](docs/bombirdier-plan.md). Each phase also has a GitHub milestone and a tracking issue; tick boxes here as work lands and close the issue when the phase's "Done when" is met.

Legend: ⬜ not started · 🟡 in progress · ✅ done

| Phase | Status | Tracking issue |
|---|---|---|
| 0. Sky-placement patch + rename | 🟡 | [#1](https://github.com/KNQuoc/Bombirdier/issues/1) |
| 1. Live traffic to 250 nm + list view | ⬜ | [#2](https://github.com/KNQuoc/Bombirdier/issues/2) |
| 2. Traffic-pattern overlay at 1G0 | ⬜ | [#3](https://github.com/KNQuoc/Bombirdier/issues/3) |
| 3. AI voice assistant (Mac server + Aivana) | ⬜ | [#4](https://github.com/KNQuoc/Bombirdier/issues/4) |
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

- [ ] `src/traffic/`: near feed (AR radius, 5–30 s) + wide feed (250 nm, ~60 s) with shared backoff, merged by id
- [ ] Measure 250 nm response size in daytime
- [ ] Settings: AR radius (km, default 50, max 100); Wide traffic on / Wi-Fi only / off
- [ ] Route lookups only for near planes + opened/focused planes
- [ ] `src/list/`: panel on both eyes, header, 8 rows/page, status colors, "below horizon"
- [ ] `ListFilter` model (kind, airline, typeCode, alt/dist ranges, climbing/descending, onGround, query, sort, page)
- [ ] Opening a plane: full card, pulse/arrow if near, distance + direction if far
- [ ] ☰ button next to ⚙
- [ ] Dev keys: `L`, `PageUp`/`PageDown`, `F`
- [ ] Radar ranges up to 463 km; radar follows the filtered list; optional `HudState.radarRangeKm`
- [ ] Done: hundreds of planes in the list in daytime, AR still ≤ 50 km, route service only for near/opened planes

## Phase 2: traffic-pattern overlay at Wood County (1G0)

- [ ] `src/airports/1g0.ts` (verify pattern directions against the FAA Chart Supplement)
- [ ] Active runway setting (default 28)
- [ ] `src/pattern/geometry.ts`: pattern legs as polylines
- [ ] `src/pattern/classify.ts` with hysteresis + unit tests (one per leg)
- [ ] Radar: runway, dashed pattern, leg labels
- [ ] Card: "Right downwind · RWY 28"
- [ ] Stretch: pattern drawn in the sky
- [ ] Done: BGSU planes in the circuit get the right leg most of the time

## Phase 3: AI voice assistant

- [ ] `mac-server/` FastAPI on :8787, `/api/health`
- [ ] mlx-whisper (`whisper-large-v3-turbo`) with aviation + callsign `initial_prompt`
- [ ] `docs/aivana.md` added by Kien → `mac-server/llm.py`
- [ ] Assistant prompt (co-pilot, short answers)
- [ ] `mac-server/tools.py`: list/radar tools, `{ answer, actions }` reply
- [ ] Phone: `rollDeg` in orientation, head-tilt push-to-talk, MediaRecorder, `RECORD_AUDIO`
- [ ] Phone: context payload, apply actions, native TTS, `HudState.voice` back on
- [ ] USB (`adb reverse`) + Wi-Fi Server URL with cleartext config
- [ ] Done: "what's that plane?" answered in < ~3 s; "show me all the jets above thirty thousand feet" opens the filtered list

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

- 2026-11-20 · phase 0 · Android build set up on the Mac (Homebrew `openjdk@21` + `android-commandlinetools`, SDK platform 36); `gradlew` made executable; debug APK builds. Not yet installed on a phone.
- 2026-11-20 · phase 0 · Sky-placement patch applied as written; app renamed to Bombirdier; type checks and TS/Python parity pass; verified in desktop dev mode on live traffic near 1G0. APK build and outdoor test still open.
- 2026-11-20 · setup · Repo created from SkyLens (history squashed to one initial commit; local `upstream` remote points at jaiden-lee/ar-plane-identifier). Plan and tracker added.
