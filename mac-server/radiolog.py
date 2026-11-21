"""A written record of what was said on the radio, and what can be worked out from it.

Off unless RADIO_LOG=on in .env. When on, every transcribed call is added as one line of JSON to
logs/radio-YYYY-MM-DD.jsonl, and every five minutes a line says how each feed was doing (so a
frequency that was silent all night can be told from one that stopped being captured). Text only:
the audio is never kept. The folder is not in git.

    {"type": "call", "ts": ..., "feedId": "dtw-twr", "facility": "dtw-app", "channel": "Tower",
     "text": "...", "seconds": 4.2, "callsignTokens": ["DAL1830"], "reportedLeg": null, "runway": null}
    {"type": "status", "ts": ..., "feeds": {"dtw-twr": {"status": "online", "peakDb": -69.2}, ...}}

summary() turns a stretch of the log into numbers: calls and conversations per controller and
channel, who was talked to most, the busiest hour. A "conversation" is a run of calls on one channel
with no pause longer than CONVERSATION_GAP_S. A call that arrives on two channels of one controller
at once (combined positions at night) is counted once.

No server packages are imported here, so the tests run on their own.
"""
import json
import time
from datetime import datetime, timedelta
from pathlib import Path

LOG_DIR = Path(__file__).resolve().parent / "logs"
STATUS_EVERY_S = 300
# A pause longer than this on a channel ends the exchange that was going on.
CONVERSATION_GAP_S = 45
# The same call heard on two channels of one controller: this close in time and this alike in words.
SAME_CALL_WITHIN_S = 8
SAME_CALL_OVERLAP = 0.6

enabled = False  # set from config by main.py


def _path(ts: float, folder: Path | None = None) -> Path:
    return (folder or LOG_DIR) / f"radio-{time.strftime('%Y-%m-%d', time.localtime(ts))}.jsonl"


def write(record: dict, folder: Path | None = None) -> None:
    """Adds one line to today's log. Never raises: a full disk must not stop the radio."""
    if not enabled and folder is None:
        return
    try:
        path = _path(record.get("ts") or time.time(), folder)
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError:
        pass


def read(since: float, until: float | None = None, folder: Path | None = None) -> list[dict]:
    """Every record between two times, oldest first."""
    until = until or time.time()
    out: list[dict] = []
    day = datetime.fromtimestamp(since).replace(hour=0, minute=0, second=0, microsecond=0)
    while day.timestamp() <= until:
        path = _path(day.timestamp(), folder)
        if path.exists():
            with open(path, encoding="utf-8") as f:
                for line in f:
                    try:
                        r = json.loads(line)
                    except ValueError:
                        continue  # a line cut short by a crash
                    if isinstance(r, dict) and since <= (r.get("ts") or 0) <= until:
                        out.append(r)
        day += timedelta(days=1)
    out.sort(key=lambda r: r.get("ts") or 0)
    return out


def _words(text: str) -> set[str]:
    return set("".join(ch if ch.isalnum() else " " for ch in (text or "").lower()).split())


def distinct(calls: list[dict]) -> list[dict]:
    """The calls with repeats taken out. At quiet hours one controller works several frequencies and
    transmits on all of them at once, so the same call arrives on two of a controller's channels a
    second or two apart, worded almost the same. The first copy is kept; `alsoOn` lists the others."""
    kept: list[dict] = []
    for c in sorted(calls, key=lambda c: c.get("ts") or 0):
        words = _words(c.get("text"))
        twin = None
        for k in reversed(kept):
            if c["ts"] - k["ts"] > SAME_CALL_WITHIN_S:
                break
            if k.get("facility") == c.get("facility") and k.get("feedId") != c.get("feedId") and len(words) >= 3:
                other = _words(k.get("text"))
                if len(words & other) / max(1, min(len(words), len(other))) >= SAME_CALL_OVERLAP:
                    twin = k
                    break
        if twin:
            twin.setdefault("alsoOn", []).append(c.get("feedId"))
        else:
            kept.append(dict(c))
    return kept


def conversations(calls: list[dict]) -> list[dict]:
    """Calls grouped into exchanges: [{feedId, start, end, calls, callsigns}], oldest first.

    An exchange is a run of calls on one channel with no pause longer than CONVERSATION_GAP_S: a
    controller and a pilot going back and forth. It goes by timing, not by callsign, because the
    transcripts of real calls often miss the callsign (the callsigns that were caught are listed)."""
    runs: dict[str, dict] = {}
    done: list[dict] = []
    for c in sorted(calls, key=lambda c: c.get("ts") or 0):
        fid = c.get("feedId") or ""
        run = runs.get(fid)
        if run and c["ts"] - run["end"] <= CONVERSATION_GAP_S:
            run["end"], run["calls"] = c["ts"] + (c.get("seconds") or 0), run["calls"] + 1
        else:
            run = {"feedId": fid, "start": c["ts"], "end": c["ts"] + (c.get("seconds") or 0), "calls": 1, "callsigns": []}
            runs[fid] = run
            done.append(run)
        for token in c.get("callsignTokens") or []:
            if token not in run["callsigns"]:
                run["callsigns"].append(token)
    return done


def summary(records: list[dict], names: dict[str, dict] | None = None) -> dict:
    """Numbers from a stretch of the log. `names`: feed id -> {facility, channel, name}, for feeds
    that never spoke (so they can be listed as silent) and for naming the ones that did."""
    names = dict(names or {})
    heard = [r for r in records if r.get("type") == "call"]
    # Counted once each, however many channels carried them.
    calls = distinct(heard)
    statuses = [r for r in records if r.get("type") == "status"]
    for c in calls:
        names.setdefault(c.get("feedId"), {"facility": c.get("facility") or c.get("feedId"), "channel": c.get("channel") or c.get("feedId")})
    convs = conversations(calls)
    per_feed: dict[str, dict] = {}
    for fid, info in names.items():
        per_feed[fid] = {"feedId": fid, "facility": info.get("facility") or fid, "channel": info.get("channel") or fid, "calls": 0, "seconds": 0.0,
                         "conversations": 0, "aircraft": set(), "checks": 0, "online": 0, "heardSound": False}
    for c in calls:
        f = per_feed[c["feedId"]]
        f["calls"] += 1
        f["seconds"] += c.get("seconds") or 0
        f["aircraft"].update(c.get("callsignTokens") or [])
    for v in convs:
        per_feed[v["feedId"]]["conversations"] += 1
    for s in statuses:
        for fid, st in (s.get("feeds") or {}).items():
            if fid in per_feed:
                per_feed[fid]["checks"] += 1
                per_feed[fid]["online"] += st.get("status") == "online"
                per_feed[fid]["heardSound"] = per_feed[fid]["heardSound"] or st.get("peakDb") is not None
    feeds = []
    for f in per_feed.values():
        feeds.append({**f, "aircraft": len(f["aircraft"]), "seconds": round(f["seconds"]),
                      # Of the five-minute checks, the share in which the feed was being captured.
                      "captured": round(f["online"] / f["checks"], 2) if f["checks"] else None})
    feeds.sort(key=lambda f: -f["calls"])
    facilities: dict[str, dict] = {}
    for f in feeds:
        g = facilities.setdefault(f["facility"], {"facility": f["facility"], "calls": 0, "conversations": 0, "channels": 0, "channelsHeard": 0})
        g["calls"] += f["calls"]
        g["conversations"] += f["conversations"]
        g["channels"] += 1
        g["channelsHeard"] += f["calls"] > 0
    by_hour: dict[str, int] = {}
    for c in calls:
        hour = datetime.fromtimestamp(c["ts"]).strftime("%Y-%m-%d %H:00")
        by_hour[hour] = by_hour.get(hour, 0) + 1
    aircraft: dict[str, int] = {}
    for c in calls:
        for token in c.get("callsignTokens") or []:
            aircraft[token] = aircraft.get(token, 0) + 1
    return {
        "from": records[0]["ts"] if records else None,
        "to": records[-1]["ts"] if records else None,
        "calls": len(calls),
        # Calls that arrived a second time on another channel of the same controller, not counted above.
        "repeats": len(heard) - len(calls),
        "conversations": len(convs),
        "aircraft": len(aircraft),
        "speechSeconds": round(sum(c.get("seconds") or 0 for c in calls)),
        "feeds": feeds,
        "facilities": sorted(facilities.values(), key=lambda g: -g["calls"]),
        "byHour": dict(sorted(by_hour.items())),
        "busiestHour": max(by_hour, key=by_hour.get) if by_hour else None,
        "mostHeard": sorted(aircraft.items(), key=lambda kv: -kv[1])[:8],
    }


def spoken(s: dict, hours: float, facility_names: dict[str, str] | None = None, only: str | None = None) -> str:
    """A summary said out loud. `only` = one controller's id, to answer "how busy was Detroit?"."""
    facility_names = facility_names or {}
    span = f"the last {round(hours)} hour{'s' if round(hours) != 1 else ''}" if hours >= 1 else f"the last {round(hours * 60)} minutes"
    if only:
        g = next((g for g in s["facilities"] if g["facility"] == only), None)
        name = facility_names.get(only, only)
        if not g or not g["calls"]:
            return f"I logged nothing on {name} in {span}."
        feeds = [f for f in s["feeds"] if f["facility"] == only and f["calls"]]
        top = feeds[0]
        text = f"{name} in {span}: {g['calls']} call{'s' if g['calls'] != 1 else ''} in about {g['conversations']} conversation{'s' if g['conversations'] != 1 else ''}"
        if g["channels"] > 1:
            text += f", on {g['channelsHeard']} of its {g['channels']} channels. Busiest was {top['channel']} with {top['calls']}."
        else:
            text += "."
        return text
    if not s["calls"]:
        return f"I logged no calls in {span}."
    heard = [g for g in s["facilities"] if g["calls"]]
    text = f"In {span} I logged {s['calls']} call{'s' if s['calls'] != 1 else ''} in about {s['conversations']} conversation{'s' if s['conversations'] != 1 else ''}"
    # Callsigns are often missed in the transcripts, so this is a floor, and said as one.
    text += f", naming at least {s['aircraft']} different aircraft. " if s["aircraft"] else ". "
    text += "Busiest: " + ", then ".join(f"{facility_names.get(g['facility'], g['facility'])} with {g['calls']}" for g in heard[:3]) + "."
    silent = [f for f in s["feeds"] if not f["calls"]]
    if silent:
        text += f" {len(silent)} channel{'s' if len(silent) != 1 else ''} had nothing."
    return text
