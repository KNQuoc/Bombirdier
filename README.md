# Bombirdier

An AR aviation companion for aviation students and plane fans at **Wood County Regional Airport (1G0)** in Bowling Green, OH. Put the phone in a Google Cardboard, look up, and see every plane at its real spot in the sky, the traffic pattern, live ATC audio linked to the planes being talked to, and a hands-free voice assistant.

Personal project by Kien, built on Jaiden Lee's **SkyLens** ([jaiden-lee/ar-plane-identifier](https://github.com/jaiden-lee/ar-plane-identifier)), used with his permission.

- **Plan:** [docs/bombirdier-plan.md](docs/bombirdier-plan.md)
- **Progress:** [PROGRESS.md](PROGRESS.md) (plus one GitHub milestone and tracking issue per phase)
- **How the codebase works:** [CLAUDE.md](CLAUDE.md) and [app/android/README.md](app/android/README.md)

## Layout

| Folder | What |
|---|---|
| `app/android/` | The Capacitor Android app (Bombirdier lives here) |
| `web/` | Shared HUD, geometry, stereo view, orientation (also the original web app) |
| `flight-service/` | Original Python flight service (kept for normalization parity checks) |
| `voice-service/` | Original voice service (its prompt seeds the Phase 3 assistant) |
| `mac-server/` | *(Phase 3+)* FastAPI server on the Mac: Whisper, Aivana, LiveATC feeds |
| `docs/` | Plan and reference docs |
