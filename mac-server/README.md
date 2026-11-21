# Bombirdier Mac server

The voice assistant's brain. The phone records a spoken question and sends it here; this Mac turns it into text, works out the answer, and sends back what to say and what to do.

```
phone ── audio + what's around ──▶  POST /api/voice/ask
                                      1. mlx-whisper: speech → text (on this Mac, audio is never stored or sent on)
                                      2. rules.py: commands with one obvious meaning are answered at once
                                      3. otherwise Aivana answers (docs/aivana.md)
                                      4. Kokoro turns the answer into speech (on this Mac)
phone ◀── { transcript, answer, actions, speech } ──
```

## Setup (once)

Needs an Apple Silicon Mac, Python 3.12 and `ffmpeg` (`brew install ffmpeg`).

```sh
cd mac-server
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env        # then put your Aivana key in it
```

The first start downloads the Whisper model (about 1.6 GB) and the Kokoro voice (about 350 MB) into `~/.cache/huggingface`. Until both are loaded, `/api/health` says `loading`.

## Run

```sh
./run.sh
```

It listens on `http://127.0.0.1:8787`, this Mac only.

- **USB (simplest):** plug the phone in. `run.sh` keeps `adb reverse tcp:8787 tcp:8787` applied (Android drops it whenever the cable reconnects, so the script re-applies it every few seconds), and the app's default server address (`http://localhost:8787`) then reaches the Mac.
- **Wi-Fi:** start with `HOST=0.0.0.0 ./run.sh`, set Settings → Mac server in the app to `http://<the Mac's IP>:8787`, and set the same long random string as `BOMBIRDIER_TOKEN` in `.env` and as Settings → Server token in the app (`openssl rand -hex 24` makes one). Without the token, questions from other machines are refused: the server can spend your Aivana credit, so it doesn't answer whoever finds it on the network. The token travels over plain http, so this is for a home network you trust, not a public one.

Who the server listens to:

- Requests must name the server by `localhost` or by IP address. This stops a web page in your browser from reaching it under a made-up domain name.
- Questions from this Mac (which is what the phone looks like over USB) need no token; from anywhere else they need `BOMBIRDIER_TOKEN`.
- Requests over 12 MB are refused unread.

Check it: `curl http://127.0.0.1:8787/api/health` → `{"ok":true,"whisper":"ready","tts":"ready","aivana":true,...}`.

Try a question without a phone:

```sh
curl -s http://127.0.0.1:8787/api/voice/ask -H 'Content-Type: application/json' \
  -d '{"text": "show me the helicopters", "context": {}}'
```

## The voice

Answers are spoken by Kokoro, a neural voice that runs on this Mac (`tts.py`), and the phone plays the audio. Generating a sentence takes 0.05–0.3 s once loaded. If the Mac has no voice (still loading, turned off, or the clip fails to play), the phone uses Android's built-in voice instead.

Pick a voice in `.env`: `TTS_VOICE=af_heart` (US female, the default), `am_michael` (US male), `bm_george` (British male), and others from the Kokoro voice list. `TTS_VOICE=` (empty) turns the Mac voice off. `TTS_SPEED=1.1` speaks a little faster.

## Radio feeds

The server can listen to a live ATC feed, cut it into individual calls, transcribe each one and tell the phone which callsign it named. The phone then highlights that plane and shows the call.

### Listening through a browser tab (how LiveATC feeds are used)

LiveATC's pages offer an in-browser player and say the streams may not be used in third-party products. So this server never connects to a LiveATC stream and has no stream addresses. You play the feed in LiveATC's own player, in a Chrome tab, and hand that tab's sound to the server:

1. Start the server, then open **<http://localhost:8787/capture>** in Chrome on this Mac.
2. For a feed, press **Open its page**, and on LiveATC press the green **LISTEN** next to the feed the card names. The player opens in a new tab named "Listening to: …" and starts playing. Leave that tab open.
3. Back on the capture page press **Capture tab**, pick the "Listening to: …" tab (the player, not the page with the LISTEN button) in Chrome's window, leave **Also share tab audio** on, and Share. The meter moves when sound is coming through, and calls appear under the feed as they are written down.

Repeat for each feed you want. A captured tab goes quiet on the Mac's speakers unless you tick the box at the top first.

Chrome shows a "Sharing … to this tab" bar on the capture page for every tab shared this way, and there is no setting to hide them. The **Bombirdier extension** in `capture-extension/` captures without them: install it once (its README has the steps), then on each player tab click its toolbar button and press **Capture this tab**. The capture page still has to be open. Capturing stops when you press Stop, close either tab, or end sharing in Chrome; nothing reconnects by itself.

The feeds on that page come from `feeds.json`:

```json
{ "id": "1g0-ctaf", "kind": "tab", "name": "Wood County CTAF", "freqs": ["122.975"],
  "page": "https://www.liveatc.net/search/?icao=1g0", "listenTo": "1G0 CTAF" }
```

`page` is the public page to open and `listenTo` is what the feed is called there. `facility` groups feeds under one controller on the phone (Detroit's five frequencies share one icon), `channel` is what this frequency is called within it, `tag` its short form in a combined transcript, and `player` the address of the site's own player page, so the extension can open it. To add a frequency: add its entry here and restart the server; the phone and the capture page pick it up by themselves. The first feed in the file is the **home frequency**: the phone shows everything said on it. On the others it shows a call only when it names a plane the app knows. The list as shipped (LiveATC pages checked 2026-11-21): Wood County CTAF, Toledo Tower and Approach (one mixed feed), Detroit Approach (Arrival West), Cleveland Center (Bluffton High, the sector over northwest Ohio) and Columbus Approach (North). Which Detroit and Cleveland sectors actually work the traffic near Bowling Green is a guess from the sector names: swap them for others on the same pages if they turn out quiet. Restart the server after changing `feeds.json`.

Every captured feed is transcribed on this Mac, on the same thread as the voice assistant. Two or three are fine; five busy ones will make voice answers wait, and calls are skipped (never queued up) when Whisper falls behind.

Nothing is recorded: each call is a temporary file deleted as soon as it is transcribed, and nothing is re-shared.

### Listening on the phone

Looking at a controller's icon in the headset and saying "Can I access?" makes the phone play that feed: `GET /api/feeds/{id}/audio` is the audio this Mac is already receiving, re-encoded as an MP3 stream for the phone's player. It goes to your own phone only (over USB, or on Wi-Fi with the server token: the phone first gets a one-time ticket from `POST /api/feeds/{id}/listen`), and nothing is stored. Try it from the Mac: `curl -m 8 -o /tmp/feed.mp3 http://127.0.0.1:8787/api/feeds/tol-app/audio`.

### Keeping a record

Set `RADIO_LOG=on` in `.env` and every transcribed call is added to `logs/radio-YYYY-MM-DD.jsonl`, one line of JSON each (the text, when, which controller and channel, the callsigns found). Every five minutes a line records how each feed was doing. Text only: the audio is never kept, and the folder is not in git. `curl 'http://127.0.0.1:8787/api/radio/summary?hours=8'` gives the counts, and the assistant answers "how busy was Detroit overnight?" from the same record. For an overnight run: leave the Mac on power with the lid open (the server stops it sleeping by itself, not a closed lid on battery), and leave Chrome and the server running.

### Other kinds of feed

`"kind": "stream"` with a `streamUrl` is for a plain web audio stream this Mac may connect to itself (your own receiver, for instance): one connection, only while the app is asking for calls, let go two minutes after it stops asking, a reconnect at most every 30 seconds.

See what's been heard: `curl 'http://127.0.0.1:8787/api/radio/events?feed=tol-app'`. Check a stream feed: `curl -X POST http://127.0.0.1:8787/api/feeds/<id>/check`.

To try the pipeline without a live feed, point `FEEDS_FILE` at a list with a `"kind": "file", "path": "/some/recording.wav"` feed: the recording is played in a loop at real speed.

## What answers what

| You say | Answered by | Measured, from end of speech to reply ready |
|---|---|---|
| "Next page", "close the list", "sort by altitude", "open number three" | `rules.py` | about 0.3 s |
| "Show me the helicopters / jets / BGSU planes", "any emergencies?" | `rules.py`; the phone counts and words the reply | about 0.3 s, plus 0.2 s for its speech |
| "Zoom the radar to 100 miles", "we're using runway one zero" | `rules.py` | about 0.4 s |
| "Help", "what can I say?" | `rules.py`: a few things to try | about 0.3 s, plus its speech |
| "What's that plane?" | `rules.py`, from the plane's own data | about 0.8 s (a long sentence to voice) |
| "When does it land?", "how far has it flown?", "when did it take off?", "where is it going?" | `flightinfo.py`, from its position, speed and route | about 0.3 s |
| "What's the weather at its destination / where it is / where it came from?" | `flightinfo.py`, live weather reports | 0.3–0.8 s |
| "What's the weather at Detroit Metro?", "will it rain in Toledo tonight?", "what's the forecast for Columbus?" | `forecast.py`, for the airport named (US and Canada) | 0.3 to 2 s (a weather lookup, cached) |
| Anything else ("only Southwest above thirty thousand", "how many seats does it have?", "why is it descending?") | Aivana | 3–6 s |

Measured on this Mac with clean test audio (macOS `say`), 2026-11-20: Whisper about 0.3 s, Kokoro 0.1–0.6 s. A real voice through a phone microphone outdoors will transcribe less cleanly.

Aivana took 3–6 seconds per call when measured (2026-11-20, `effort: low`), which is why the common commands don't go through it.

## Files

| File | What |
|---|---|
| `main.py` | The HTTP endpoints: `GET /api/health`, `POST /api/voice/ask` |
| `transcribe.py` | mlx-whisper (`whisper-large-v3-turbo`), prompted with aviation words and the callsigns in view; drops what Whisper makes up from silence or noise |
| `tts.py` | Kokoro speech (mlx-audio) |
| `gpu.py` | The single thread all model work runs on |
| `rules.py` | Instant commands |
| `flightinfo.py` | Flight progress, arrival estimates and weather for the plane being asked about |
| `llm.py` | The only file that talks to Aivana. Replace it to use another LLM |
| `prompt.py` | The assistant's persona and how the phone's context is written out for it |
| `tools.py` | The actions the assistant can ask the phone to carry out, as a JSON Schema, and their validation |
| `speech.py` | Wording plane data for speech (distances in nautical miles, said as "miles") |
| `feeds.py`, `feeds.json` | Radio feeds: audio in (from a captured browser tab, or ffmpeg for a stream or test file) → calls → Whisper → events |
| `capture.html` | The page at `/capture` that sends a Chrome tab's sound to the server |
| `capture-extension/` | Optional Chrome extension: captures tabs for that page without Chrome's sharing bars |
| `splitter.py` | Cuts a continuous audio stream into individual calls |
| `radio_parse.py` | Callsigns and position reports out of a transcribed call |
| `radio.py` | The feed and radio endpoints, including the live audio stream the phone plays |
| `opensky.py` | When and where a plane really took off, from the OpenSky Network's free track of the flight |
| `airports.py` | Which airfield a point is at, for naming where a plane left from (`data/airports.json`, made by `build_airports.py` from OurAirports) |
| `forecast.py` | Weather where you are and airport forecasts (aviationweather.gov), answered without Aivana |
| `radiolog.py` | The optional written record of calls (`RADIO_LOG=on`) and its summary |
| `radiotalk.py` | Radio voice commands answered without Aivana: "Can I access?", mute, transcript, "what did they just say?" |
| `test_server.py` | `python3 test_server.py`: rules, speech, flight info and action checks. No network, no model |
| `test_radio.py` | `python3 test_radio.py`: the radio parser and the call splitter |

## Flight times are estimates

Arrival time is distance to go ÷ current ground speed, and "left about … ago" is distance flown ÷ a typical average speed. They are usually within a few minutes for a plane in cruise and rougher for one climbing, holding or being vectored. The answers say they are estimates.

Real scheduled and actual times would need a flight-status service with an API key (for example FlightAware AeroAPI or AirLabs). Without one there is no source: adsb.lol carries positions only, its flight-history pages are not open to programs, and asking Aivana to search the web found nothing live. Weather is real: current airport reports from aviationweather.gov.

## Privacy

- Audio stays on this Mac: it is written to a temporary file for Whisper and deleted straight after. Speech is generated here too.
- What goes to Aivana: the transcribed question and a few lines about the planes around you, the airport and the list. No audio, no location beyond "at Wood County" and distances.
- Weather lookups go to aviationweather.gov (a US government service) and carry only airport codes and a box around the plane being asked about, never your position.
- The Aivana key is read from `.env`, which is gitignored. It is never sent to the phone.
