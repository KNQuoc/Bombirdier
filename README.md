# Bombirdier

An AR aviation companion for flight students and plane fans at **Wood County Regional Airport (1G0)** in Bowling Green, OH, home of the BGSU flight program.

**The problem.** From the ground you can see a plane but not what it is, where it is going, which leg of the traffic pattern it is flying, or who it is talking to. Finding out means a flight tracker in one hand and a radio scanner in the other.

**What it does.** Put the phone in a Google Cardboard and look up:

- every plane gets a marker at its real spot in the sky, and the one you look at gets a card (type, route, altitude, speed, where it left from);
- the home field's runways and traffic pattern are drawn, and planes in the pattern are labelled with their leg;
- live air traffic control calls are transcribed, and a call that names a plane lights that plane up;
- a hands-free voice assistant answers questions and works the app: tip your head to one side, then ask.

Personal project by da squad
- **Plan:** [docs/bombirdier-plan.md](docs/bombirdier-plan.md)
- **Progress:** [PROGRESS.md](PROGRESS.md) (plus one GitHub milestone and tracking issue per phase)
- **How the codebase works:** [CLAUDE.md](CLAUDE.md), [app/android/README.md](app/android/README.md) and [mac-server/README.md](mac-server/README.md)

## Run it

There are two parts: a server on a Mac (speech, the assistant, radio) and the app (a phone, or a desktop browser for trying it without one).

### 1. The Mac server

Needs an Apple Silicon Mac, Python 3.12 and `ffmpeg` (`brew install ffmpeg`).

```sh
cd mac-server
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env        # then put your Aivana key in it
./run.sh
```

The first start downloads the speech models (about 2 GB). It is ready when this answers `"whisper":"ready"`:

```sh
curl http://127.0.0.1:8787/api/health
```

The Aivana key lives only in `mac-server/.env`, which is gitignored. It is never sent to the phone and is not in this repository.

### 2a. In a desktop browser (no phone needed)

```sh
cd app/android
npm ci
npm run dev
```

Open `http://localhost:5174/?dev=1&at=41.391,-83.6301` (`at` is a fixed position: Wood County). Arrow keys look around, `V` talks (press again to send), `L` opens the plane list, `C` listens to the controller in view. The full key list is at the end of the Bombirdier section of [CLAUDE.md](CLAUDE.md).

To send a typed question through the whole assistant, in the browser console:

```js
bombirdier.ask('show me the helicopters')
```

### 2b. On an Android phone

Build and install steps are in [app/android/README.md](app/android/README.md) (Node, the Android SDK and JDK 21):

```sh
cd app/android
npm ci
npm run apk
npm run install-apk
```

Plug the phone into the Mac: `run.sh` keeps the USB link to the server up, and the app finds it at its default address. The app asks for camera, location and microphone the first time.

## Try it in five minutes

1. Start the server and open the desktop link above (or the app on the phone, outdoors).
2. Look around until a plane's card drops down. Ask **"what's that plane?"**.
3. Ask **"when does it land?"** or **"where did it come from?"**.
4. Say **"show me the helicopters"**, then **"sort by altitude"**, then **"close the list"**.
5. Ask something open, such as **"how many seats does it have?"** (this one goes to Aivana and takes a few seconds).
6. Ask **"what's the weather?"**, or **"what's the weather at Detroit Metro?"**.
7. Say **"what can I say?"** for more.

On the phone, talking starts with a head tilt held for about a second, or two fingers on the screen when the phone is in your hand.

Radio calls need one more step, a Chrome tab playing the frequency: see "Radio feeds" in [mac-server/README.md](mac-server/README.md).

## How Aivana is used

Aivana is the assistant's language model. It is called from one file, [mac-server/llm.py](mac-server/llm.py), and only for questions that need it.

- **Structured output.** Aivana has no tool calling, so every call passes a strict JSON Schema ([mac-server/tools.py](mac-server/tools.py)) and gets back `{ answer, actions }`: what to say aloud, and what to do in the app (open the list, filter it, change the radar, switch radio channel). Each action is checked again in our code before the phone carries it out.
- **Multi-turn.** The last three exchanges from the past two minutes are sent along, so a follow-up such as "and its range?" works after "how many seats does it have?".
- **Used where it helps.** Commands with one obvious meaning ("next page", "what's that plane?", "mute") are answered by rules in under a second and never reach Aivana, which took 3 to 6 seconds per call when measured. Open questions and anything with several conditions ("only Southwest above thirty thousand") go to it.
- **No sums left to the model.** Distance flown, distance to go, arrival estimates, counts and unit conversions are worked out in code and given to Aivana as facts.
- **Token use.** Effort `low`, answers capped at 220 tokens, and the context is a few lines about the planes in view rather than the whole traffic picture.
- **When it fails.** One quick retry on a rate limit, a 20 second limit on waiting, and a spoken reason that matches the cause: no key, out of credit, spending limit reached, busy, or unreachable. Everything answered by rules keeps working.
- **Not used:** web search (tried for flight times and weather, and it returned wrong live data: see [docs/aivana.md](docs/aivana.md)), streaming, and image input.

## Known limits

- **Arrival times are estimates** from distance and speed, and the answers say so. There is no free source of airline schedules.
- **Small planes have no route on file.** Where one left from is worked out by watching it, so it is only known for planes seen leaving, or when OpenSky has the track.
- **Radio transcripts are rough.** Plain airline callsigns usually come out right; clipped or unusual ones are often missed.
- **Who a plane is talking to is a guess** from its position and altitude until a call is actually heard. The app says "likely".
- **Traffic pattern labels** are tuned on one recorded landing so far.
- **Coverage.** Plane data comes from volunteer receivers (adsb.lol, adsb.fi). Planes without ADS-B, and planes low near a field with no receiver nearby, do not appear. Both sources limit how often they can be asked.
- **The compass** is unreliable indoors and near steel, which moves every marker sideways.
- **Networks with a sign-in page** block the plane data until you sign in; the app says so.
- **One airport.** The pattern, runways and controller list are written for Wood County.
- **Setup.** The assistant and radio need the Mac server on an Apple Silicon Mac. Without it the app still shows planes.
- Several features have been checked in the desktop preview but not yet in the headset: see the unticked items in [PROGRESS.md](PROGRESS.md).

## Data and privacy

- Plane positions are public ADS-B broadcasts. Weather is from aviationweather.gov, tracks from OpenSky, airfields from OurAirports.
- Your voice is transcribed on the Mac and not kept. Aivana receives the transcribed question and a few lines about nearby planes: no audio, and no location beyond "at Wood County" and distances.
- Radio audio is never saved. An optional text log of transcripts stays on the Mac.

## Tests

```sh
cd app/android && npm test
cd mac-server && python3 test_server.py && python3 test_radio.py
```

No network and no model needed.

## Layout

| Folder | What |
|---|---|
| `app/android/` | The Capacitor Android app (Bombirdier lives here) |
| `web/` | Shared HUD, geometry, stereo view, orientation (also the original web app) |
| `mac-server/` | FastAPI server on the Mac: speech-to-text, the Aivana assistant, spoken answers, radio feeds |
| `flight-service/` | Original Python flight service (kept for normalization parity checks) |
| `voice-service/` | Original voice service (its prompt seeded the assistant) |
| `docs/` | Plan and reference docs |
