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
PORT = int(os.environ.get("PORT", "8787"))
USER_AGENT = "Bombirdier/0.1 (personal project)"
