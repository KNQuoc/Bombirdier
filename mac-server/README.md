# Bombirdier Mac server

The voice assistant's brain. The phone records a spoken question and sends it here; this Mac turns it into text, works out the answer, and sends back what to say and what to do.

```
phone ── audio + what's around ──▶  POST /api/voice/ask
                                      1. mlx-whisper: speech → text (on this Mac, audio is never stored or sent on)
                                      2. rules.py: commands with one obvious meaning are answered at once
                                      3. otherwise Aivana answers (docs/aivana.md)
phone ◀── { transcript, answer, actions } ──
```

## Setup (once)

Needs an Apple Silicon Mac, Python 3.12 and `ffmpeg` (`brew install ffmpeg`).

```sh
cd mac-server
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env        # then put your Aivana key in it
```

The first question downloads the Whisper model (about 1.6 GB) into `~/.cache/huggingface`.

## Run

```sh
./run.sh
```

It listens on `http://127.0.0.1:8787`, this Mac only.

- **USB (simplest):** with the phone plugged in, run `adb reverse tcp:8787 tcp:8787`. The app's default server address (`http://localhost:8787`) then reaches the Mac. Run it again after reconnecting the cable.
- **Wi-Fi:** start with `HOST=0.0.0.0 ./run.sh` and set Settings → Mac server in the app to `http://<the Mac's IP>:8787`. This lets anything on your network use the server, and with it your Aivana credit, so only do it on a network you trust.

Check it: `curl http://127.0.0.1:8787/api/health` → `{"ok":true,"whisper":"ready","aivana":true}`.

Try a question without a phone:

```sh
curl -s http://127.0.0.1:8787/api/voice/ask -H 'Content-Type: application/json' \
  -d '{"text": "show me the helicopters", "context": {}}'
```

## What answers what

| You say | Answered by | Typical time after you stop talking |
|---|---|---|
| "Next page", "close the list", "sort by altitude", "open number three" | `rules.py` | Whisper only |
| "Show me the helicopters / jets / BGSU planes", "any emergencies?" | `rules.py`; the phone counts and words the reply | Whisper only |
| "Zoom the radar to 100 miles", "we're using runway one zero" | `rules.py` | Whisper only |
| "What's that plane?" | `rules.py`, from the plane's own data | Whisper only |
| Anything else ("only Southwest above thirty thousand", "how many seats does it have?", "why is it descending?") | Aivana | Whisper + 3–6 s |

Aivana took 3–6 seconds per call when measured (2026-11-20, `effort: low`), which is why the common commands don't go through it.

## Files

| File | What |
|---|---|
| `main.py` | The HTTP endpoints: `GET /api/health`, `POST /api/voice/ask` |
| `transcribe.py` | mlx-whisper (`whisper-large-v3-turbo`), prompted with aviation words and the callsigns in view |
| `rules.py` | Instant commands |
| `llm.py` | The only file that talks to Aivana. Replace it to use another LLM |
| `prompt.py` | The assistant's persona and how the phone's context is written out for it |
| `tools.py` | The actions the assistant can ask the phone to carry out, as a JSON Schema, and their validation |
| `speech.py` | Wording plane data for speech (distances in nautical miles, said as "miles") |
| `test_server.py` | `python3 test_server.py`: rules, speech and action checks. No network, no model |

## Privacy

- Audio stays on this Mac: it is written to a temporary file for Whisper and deleted straight after.
- What goes to Aivana: the transcribed question and a few lines about the planes around you, the airport and the list. No audio, no location beyond "at Wood County" and distances.
- The Aivana key is read from `.env`, which is gitignored. It is never sent to the phone.
