#!/bin/sh
# Starts the Mac server. Default: this Mac only, with the phone reaching it over USB.
# For Wi-Fi, let other devices on the network reach it:  HOST=0.0.0.0 ./run.sh
cd "$(dirname "$0")" || exit 1
[ -d .venv ] || { echo "First: python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt"; exit 1; }
PORT="${PORT:-8787}"
if [ "${HOST:-127.0.0.1}" != "127.0.0.1" ] && ! grep -Eq '^BOMBIRDIER_TOKEN=.+' .env 2>/dev/null; then
  echo "Listening on the network, but BOMBIRDIER_TOKEN is empty in .env: questions from the phone will be refused."
  echo "Set one (openssl rand -hex 24) in .env and in the app under Settings -> Server token."
fi

# USB link: `adb reverse` makes the phone's localhost:8787 reach this Mac. Android drops it every time
# the cable or USB debugging reconnects, so it is re-applied every few seconds while the server runs.
if command -v adb >/dev/null 2>&1; then
  ( while :; do adb reverse "tcp:$PORT" "tcp:$PORT" >/dev/null 2>&1; sleep 5; done ) &
  LINK=$!
  trap 'kill "$LINK" 2>/dev/null' EXIT INT TERM
  echo "USB link: keeping adb reverse tcp:$PORT up (plug the phone in any time)."
fi

# Keep the Mac from going to sleep by itself while the server runs (a sleeping Mac captures and logs
# nothing). The screen may still turn off, and closing the lid on battery still sleeps it.
if command -v caffeinate >/dev/null 2>&1; then
  caffeinate -i .venv/bin/uvicorn main:app --host "${HOST:-127.0.0.1}" --port "$PORT"
else
  .venv/bin/uvicorn main:app --host "${HOST:-127.0.0.1}" --port "$PORT"
fi
