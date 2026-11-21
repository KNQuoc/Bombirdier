#!/bin/sh
# Starts the Mac server. Default: this Mac only (the phone connects over USB with
#   adb reverse tcp:8787 tcp:8787
# ). For Wi-Fi, let other devices on the network reach it:  HOST=0.0.0.0 ./run.sh
cd "$(dirname "$0")" || exit 1
[ -d .venv ] || { echo "First: python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt"; exit 1; }
exec .venv/bin/uvicorn main:app --host "${HOST:-127.0.0.1}" --port "${PORT:-8787}"
