"""Settings for the Mac server, read from mac-server/.env (see .env.example). The key never leaves this machine."""
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _load_env_file(path: Path) -> None:
    """KEY=value lines; real environment variables win. (No python-dotenv: one less thing to install.)"""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


_load_env_file(HERE / ".env")

AIVANA_API_KEY = os.environ.get("AIVANA_API_KEY", "")
AIVANA_URL = "https://api.aivana.ai/v1/generate"
# A ceiling on how much reasoning Aivana applies: auto | low | medium | high. Low is the fastest.
AIVANA_EFFORT = os.environ.get("AIVANA_EFFORT", "low")
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")
# The assistant's voice (Kokoro). af_heart = US female, am_michael = US male, bm_george = British male,
# and many more: the first letter is the accent (a = American, b = British). Empty = no Mac voice;
# the phone then uses Android's built-in one.
TTS_VOICE = os.environ.get("TTS_VOICE", "af_heart")
TTS_MODEL = os.environ.get("TTS_MODEL", "mlx-community/Kokoro-82M-bf16")
TTS_SPEED = float(os.environ.get("TTS_SPEED", "1.0"))
PORT = int(os.environ.get("PORT", "8787"))
# Shared secret for requests that don't come from this Mac itself (Wi-Fi). Requests over USB
# (adb reverse) arrive from 127.0.0.1 and don't need it. Empty = only this Mac may ask questions.
SERVER_TOKEN = os.environ.get("BOMBIRDIER_TOKEN", "")
USER_AGENT = "Bombirdier/0.1 (personal project)"
# Keep a written record of radio calls (text only, in mac-server/logs/, not in git). See radiolog.py.
RADIO_LOG = os.environ.get("RADIO_LOG", "").strip().lower() in ("1", "on", "true", "yes")
