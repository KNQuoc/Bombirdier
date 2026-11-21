"""Voice commands about the radio, answered without Aivana: connecting to a controller's frequency
("Can I access?"), muting, the transcript, "what did they just say?", "who is it talking to?".

Pure functions of the words and the context, like rules.py (which calls quick() here), so they are
tested without the server. What they need to know arrives in the context:

  station       the controller the user is looking at: {id, name, freqs, feedId}
  focus.radio   for a plane: who it is probably talking to: {facility, name, freq, feedId, heardAgoS}
  radio         {connected: feed id or None, audio: bool, transcript: bool, stations: [{id, name, feedId}]}
  feeds         every feed's state as the server sees it (added by the server, not the phone)
  radioRecent   the latest calls on the connected feed, oldest first (added by the server)
"""
import re

from radio_parse import spoken_form

# What a controller can be called out loud -> a word that appears in the station's name or id.
_NAMES = {
    "toledo": "toledo", "toledo approach": "toledo", "toledo tower": "toledo", "approach": "toledo",
    "detroit": "detroit", "detroit approach": "detroit", "metro": "detroit",
    "cleveland": "cleveland", "cleveland center": "cleveland", "center": "cleveland",
    "columbus": "columbus", "columbus approach": "columbus",
    "wood county": "wood county", "ctaf": "wood county", "the ctaf": "wood county", "bowling green": "wood county",
    "the field": "wood county", "the pattern": "wood county", "the airport": "wood county", "home": "wood county",
}
_IT = r"it|this|that|this one|that one|them|him|her|in|this plane|that plane|this frequency|that frequency|the radio|the frequency"
_NAMED = "|".join(sorted(map(re.escape, _NAMES), key=len, reverse=True))


def say_freq(freq: str) -> str:
    """"126.1" the way it is said on the radio, and so the voice doesn't read it as a number: "1 2 6 point 1"."""
    whole, _, frac = str(freq).partition(".")
    return " ".join(whole) + (" point " + " ".join(frac) if frac else "")


def ago(seconds: float) -> str:
    s = max(0, round(seconds))
    if s < 50:
        return f"{max(5, round(s / 5) * 5)} seconds ago"
    minutes = round(s / 60)
    return "a minute ago" if minutes <= 1 else f"{minutes} minutes ago"


def _reply(answer: str, *actions: dict) -> dict:
    return {"answer": answer, "actions": list(actions)}


def _stations(ctx: dict) -> list[dict]:
    return list((ctx.get("radio") or {}).get("stations") or [])


def _feed_state(ctx: dict, feed_id: str | None) -> str | None:
    """online / offline / idle / connecting for a feed, None if the server has no such feed."""
    for f in ctx.get("feeds") or []:
        if f.get("id") == feed_id:
            return f.get("status")
    return None


def _named_station(ctx: dict, words: str) -> dict | None:
    key = _NAMES.get(re.sub(r"^(the|to) ", "", words))
    if not key:
        return None
    return next((s for s in _stations(ctx) if key in (s.get("name") or "").lower()), None)


def _other_live(ctx: dict, not_feed: str | None) -> dict | None:
    for s in _stations(ctx):
        if s.get("feedId") and s["feedId"] != not_feed and _feed_state(ctx, s["feedId"]) == "online":
            return s
    return None


def _connect(ctx: dict, name: str, feed_id: str | None, lead: str = "") -> dict:
    """The reply to "connect me to this": yes and connect, or why not and what else is live."""
    state = _feed_state(ctx, feed_id) if feed_id else None
    if state == "online":
        if (ctx.get("radio") or {}).get("connected") == feed_id:
            return _reply(f"You're already on {name}.")
        return _reply(f"{lead}{'Connecting' if lead else f'Yes, {name} is live. Connecting'}.", {"type": "connect_feed", "feed": feed_id})
    other = _other_live(ctx, feed_id)
    instead = f" {other['name']} is live, say connect to {other['name'].split(' (')[0]} for that." if other else ""
    if not feed_id or state is None:
        return _reply(f"{lead}There's no live feed for {name}.{instead}")
    return _reply(f"{lead}{name} isn't playing on the Mac right now.{instead}")


def _plane_radio(ctx: dict) -> dict | None:
    plane = ctx.get("focus") or ctx.get("opened")
    return (plane or {}).get("radio") or None


def _who(radio: dict) -> str:
    """"Probably Toledo Approach on 1 2 6 point 1. I heard it there a minute ago." """
    where = radio.get("name") or "a controller I don't know"
    freq = f" on {say_freq(radio['freq'])}" if radio.get("freq") else ""
    if radio.get("heardAgoS") is not None:
        return f"{where}{freq}. I heard it there {ago(radio['heardAgoS'])}."
    return f"Probably {where}{freq}. I haven't heard it on the radio."


def quick(t: str, ctx: dict) -> dict | None:
    """`t` is the normalized utterance (see rules.normalize). None = not a radio command."""
    radio = ctx.get("radio") or {}
    connected = radio.get("connected")
    station = ctx.get("station")

    # --- Can I access? / connect / listen / tune in
    m = re.fullmatch(
        rf"(?:can i |can we |let me |i want to |id like to )?(?:get )?(?:access|connect(?: me)?|listen(?: in)?|tune(?: in)?|hear|patch me in)(?: to| into| on)?(?: ({_IT}|(?:the )?(?:{_NAMED})))?(?: frequency)?",
        t,
    )
    if m:
        target = (m.group(1) or "").strip()
        named = _named_station(ctx, target) if target and not re.fullmatch(_IT, target) else None
        if named:
            return _connect(ctx, named["name"], named.get("feedId"))
        if station:
            return _connect(ctx, station.get("name", "that controller"), station.get("feedId"))
        guess = _plane_radio(ctx)
        if guess:
            heard = f", and I heard it there {ago(guess['heardAgoS'])}" if guess.get("heardAgoS") is not None else ""
            return _connect(ctx, guess.get("name", "its controller"), guess.get("feedId"), lead=f"It's probably on {guess.get('name')}{heard}. ")
        live = [s for s in _stations(ctx) if s.get("feedId") and _feed_state(ctx, s["feedId"]) == "online"]
        if len(live) == 1:
            return _connect(ctx, live[0]["name"], live[0]["feedId"])
        if live:
            return _reply("Point at a controller or a plane, or say which one: " + ", ".join(s["name"].split(" (")[0] for s in live[:4]) + ".")
        return _reply("No radio feed is playing on the Mac right now.")

    # --- Leaving
    if re.fullmatch(r"disconnect(?: me| the radio| from .+)?|stop listening|leave(?: the)? (?:frequency|radio)|hang up|close the radio", t):
        return _reply("Disconnected." if connected else "You're not connected to a frequency.", {"type": "disconnect_feed"})

    # --- Sound and transcript: separate switches
    switches = [
        (rf"mute(?: (?:the radio|it|them|(?:the )?(?:{_NAMED})))?|radio off|silence(?: the radio)?|turn (?:the radio|it) off", "Radio muted.", [("radio_audio", "off")]),
        (rf"unmute(?: (?:the radio|it|them|(?:the )?(?:{_NAMED})))?|radio on|sound on|turn (?:the radio|it) (?:back )?on", "Radio on.", [("radio_audio", "on")]),
        (r"(?:turn (?:it|the radio|the volume) down|turn down the (?:radio|volume)|volume down|quieter|softer|lower)", "Quieter.", [("radio_audio", "down")]),
        (r"(?:turn (?:it|the radio|the volume) up|turn up the (?:radio|volume)|volume up|louder)", "Louder.", [("radio_audio", "up")]),
        (r"hide(?: the)? transcript|transcript off|no transcript", "Transcript hidden.", [("transcript", "hide")]),
        (r"show(?: me)?(?: the)? transcript|transcript on", "Transcript on.", [("transcript", "show")]),
        (r"transcript only|just(?: the)? transcript", "Transcript only.", [("radio_audio", "off"), ("transcript", "show")]),
        (r"audio only|sound only|just(?: the)? (?:audio|sound)", "Audio only.", [("radio_audio", "on"), ("transcript", "hide")]),
    ]
    for pattern, answer, actions in switches:
        if re.fullmatch(pattern, t):
            if not connected:
                return _reply("You're not connected to a frequency. Point at a controller and say can I access.")
            return _reply(answer, *({"type": kind, "state": state} for kind, state in actions))

    # --- What was said
    recent = ctx.get("radioRecent") or []
    if re.fullmatch(r"what did (?:they|he|she|atc|the controller|the tower|approach|center) (?:just )?say|what was that(?: call| last call)?|what was the last call|repeat the last call|what did i miss", t):
        if not recent:
            return _reply("Nothing has been said on the radio in the last few minutes." if connected else "I haven't heard anything on the radio in the last few minutes.")
        last = recent[-1]
        return _reply(f"{ago(last['agoS']).capitalize()}: {last['text']}")
    if re.fullmatch(r"who(?:s| is| else is)? on (?:this|the|that) frequency|who(?:s| is) on frequency|who have you heard|who is talking", t):
        tokens = list(dict.fromkeys(tok for e in recent for tok in e.get("callsignTokens") or []))
        if not tokens:
            return _reply("I haven't heard anyone on it in the last few minutes.")
        names = [spoken_form(tok) for tok in tokens[-6:]]
        return _reply("In the last few minutes I heard " + (names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]) + ".")

    # --- Who is this plane talking to
    if re.fullmatch(r"who(?:s| is)? (?:it|that|this|he|she|that plane|this plane|this one|that one) talking to|what frequency is (?:it|that|this|he|she|that plane|this plane|this one|that one) on|who(?:s| is) (?:controlling|working) (?:it|that|this|that plane|this plane|this one|that one)|who controls (?:it|that|this|that plane|this plane)|who has (?:it|that one|this one)", t):
        guess = _plane_radio(ctx)
        if guess:
            return _reply(_who(guess))
        return _reply("Point at a plane first, and I'll tell you who it's probably talking to.")

    # --- What's live
    m = re.fullmatch(rf"is (?:the )?({_NAMED}) (?:live|online|up|on|working|playing|available)", t)
    if m:
        named = _named_station(ctx, m.group(1))
        if named:
            state = _feed_state(ctx, named.get("feedId")) if named.get("feedId") else None
            return _reply(f"Yes, {named['name']} is live." if state == "online" else f"No, {named['name']} isn't playing right now.")
    if re.fullmatch(r"(?:which|what) (?:feeds|frequencies|radios|controllers) (?:are|is) (?:live|online|up|on|playing|available)|whats live|what can i listen to", t):
        live = [s["name"] for s in _stations(ctx) if s.get("feedId") and _feed_state(ctx, s["feedId"]) == "online"]
        if not live:
            return _reply("No radio feed is playing on the Mac right now.")
        return _reply(("Live right now: " + ", ".join(live) + ".") if len(live) > 1 else f"Only {live[0]} is live right now.")
    return None
