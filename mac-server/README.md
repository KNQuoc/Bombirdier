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

Set a feed up in `feeds.json`:

```json
{ "id": "1g0-ctaf", "kind": "liveatc", "name": "Wood County CTAF", "freqs": ["122.975"], "streamUrl": "" }
```

`streamUrl` is empty on purpose. LiveATC lists two feeds for this area (checked 2026-11-21): **1G0 CTAF** (Wood County, 122.975) and **KTOL Del/Gnd/Twr/App** (Toledo Approach 126.1 and 134.35 mixed with Tower, Ground and Clearance). Its pages used to offer a "listen" link that downloaded a `.pls` file with the stream address in it; they now offer only an in-browser player, and say streams may not be used in third-party products. Whether and how to get an address is the owner's decision, not something this code does. Restart the server after changing `feeds.json`.

LiveATC's terms don't allow third-party use of its streams. This is for private, personal listening, and the server behaves accordingly: one connection per feed, only while the app is open and asking for calls (it lets go two minutes after the app stops asking), a reconnect at most every 30 seconds, an honest User-Agent, nothing recorded (each call is a temporary file deleted as soon as it's transcribed), nothing re-shared.

Check a feed: `curl -X POST http://127.0.0.1:8787/api/feeds/tol-app/check`. See what's been heard: `curl 'http://127.0.0.1:8787/api/radio/events?feed=tol-app'` (this also starts the feed).

To try the pipeline without a live stream, point `FEEDS_FILE` at a list with a `"kind": "file", "path": "/some/recording.wav"` feed: the recording is played in a loop at real speed.

## What answers what

| You say | Answered by | Measured, from end of speech to reply ready |
|---|---|---|
| "Next page", "close the list", "sort by altitude", "open number three" | `rules.py` | about 0.3 s |
| "Show me the helicopters / jets / BGSU planes", "any emergencies?" | `rules.py`; the phone counts and words the reply | about 0.3 s, plus 0.2 s for its speech |
| "Zoom the radar to 100 miles", "we're using runway one zero" | `rules.py` | about 0.4 s |
| "What's that plane?" | `rules.py`, from the plane's own data | about 0.8 s (a long sentence to voice) |
| "When does it land?", "how far has it flown?", "when did it take off?", "where is it going?" | `flightinfo.py`, from its position, speed and route | about 0.3 s |
| "What's the weather at its destination / where it is / where it came from?" | `flightinfo.py`, live weather reports | 0.3–0.8 s |
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
| `feeds.py`, `feeds.json` | Radio feeds: one worker per feed in use (ffmpeg → calls → Whisper → events) |
| `splitter.py` | Cuts a continuous audio stream into individual calls |
| `radio_parse.py` | Callsigns and position reports out of a transcribed call |
| `radio.py` | The feed and radio endpoints |
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
