"""Voice commands about the radio, answered without Aivana: connecting to a controller's frequency
("Can I access?"), muting, the transcript, "what did they just say?", "who is it talking to?".

Pure functions of the words and the context, like rules.py (which calls quick() here), so they are
tested without the server. What they need to know arrives in the context:

  station       the controller the user is looking at: {id, name, freqs, feedId}
  focus.radio   for a plane: who it is probably talking to: {facility, name, freq, feedId, heardAgoS}
  radio         {connected: feed id or None, scope: "facility" | "channel", audio: bool, transcript: bool,
                 stations: [{id, name, feedId, channels: [{feedId, name}]}]}
                A controller with several frequencies (Detroit: Arrival West, Arrival East, Tower...) has
                one feed per frequency, its "channels". Connecting to the controller plays one of them
                and puts all of them in the transcript; a channel can also be picked on its own.
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


def _channels(station: dict) -> list[dict]:
    """A controller's frequencies, each {feedId, name}. One with a single feed has one channel, named after itself."""
    listed = [c for c in station.get("channels") or [] if c.get("feedId")]
    if listed:
        return listed
    return [{"feedId": station["feedId"], "name": station.get("name")}] if station.get("feedId") else []


def _live(ctx: dict, station: dict) -> list[dict]:
    return [c for c in _channels(station) if _feed_state(ctx, c["feedId"]) == "online"]


def _station_of(ctx: dict, feed_id: str | None) -> dict | None:
    return next((s for s in _stations(ctx) if any(c["feedId"] == feed_id for c in _channels(s))), None) if feed_id else None


def _busiest(ctx: dict, live: list[dict]) -> dict:
    """Of the channels that are live, the one that spoke most recently (the first, if none has yet)."""
    last = {f.get("id"): f.get("lastCallAt") or 0 for f in ctx.get("feeds") or []}
    return max(live, key=lambda c: last.get(c["feedId"], 0))


def _and(names: list[str]) -> str:
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]


def _named_station(ctx: dict, words: str) -> dict | None:
    key = _NAMES.get(re.sub(r"^(the|to) ", "", words))
    if not key:
        return None
    return next((s for s in _stations(ctx) if key in (s.get("name") or "").lower()), None)


def _other_live(ctx: dict, not_station: dict | None) -> dict | None:
    for s in _stations(ctx):
        if s is not not_station and s.get("id") != (not_station or {}).get("id") and _live(ctx, s):
            return s
    return None


# Words that say nothing about which channel is meant.
_FILLER = {"the", "a", "on", "to", "of", "channel", "frequency", "sector", "feed", "approach", "center", "control", "controller", "radio", "one"}


def _find_channel(ctx: dict, words: str, stations: list[dict]) -> tuple[dict, dict] | None:
    """(station, channel) for a channel named out loud ("arrival east", "tower"), looking only at
    controllers that have more than one. Live channels win; no clear winner means no match."""
    wanted = [w for w in words.split() if w not in _FILLER]
    if not wanted:
        return None
    hits = []
    for s in stations:
        chans = _channels(s)
        if len(chans) < 2:
            continue
        for c in chans:
            have = (c.get("name") or "").lower().split()
            if all(any(h == w or h.startswith(w) for h in have) for w in wanted):
                hits.append((s, c))
    live = [h for h in hits if _feed_state(ctx, h[1]["feedId"]) == "online"]
    pool = live or hits
    return pool[0] if len(pool) == 1 or (pool and all(h[0] is pool[0][0] for h in pool) and len(live) == 1) else None


def _connect_station(ctx: dict, station: dict, lead: str = "") -> dict:
    """The reply to "connect me to this controller": yes and connect, or why not and what else is live."""
    radio = ctx.get("radio") or {}
    name = station.get("name") or "that controller"
    chans, live = _channels(station), _live(ctx, station)
    if not live:
        other = _other_live(ctx, station)
        instead = f" {other['name']} is live, say connect to {other['name'].split(' (')[0]} for that." if other else ""
        if not chans or all(_feed_state(ctx, c["feedId"]) is None for c in chans):
            return _reply(f"{lead}There's no live feed for {name}.{instead}")
        return _reply(f"{lead}{name} isn't playing on the Mac right now.{instead}")
    connected = radio.get("connected")
    if len(chans) == 1:
        if connected == live[0]["feedId"]:
            return _reply(f"You're already on {name}.")
        return _reply(f"{lead}{'Connecting' if lead else f'Yes, {name} is live. Connecting'}.", {"type": "connect_feed", "feed": live[0]["feedId"]})
    # Several frequencies under one controller: play one, and put all of them in the transcript.
    current = next((c for c in live if c["feedId"] == connected), None)
    if current and radio.get("scope") == "facility":
        return _reply(f"You're already on {name}, playing {current['name']}.")
    pick = current or _busiest(ctx, live)
    opener = lead or "Yes, "
    if len(live) == 1:
        say = f"{opener}{name} has 1 of {len(chans)} channels live: {pick['name']}. Connecting."
    else:
        say = f"{opener}{name} has {len(live)} of {len(chans)} channels live. Playing {pick['name']}, with {'both' if len(live) == 2 else 'all of them'} in the transcript."
    return _reply(say, {"type": "connect_feed", "feed": pick["feedId"], "scope": "facility"})


def _connect_channel(ctx: dict, station: dict, channel: dict, scope: str | None) -> dict:
    """One named channel of a controller. `scope` "channel" = only its calls in the transcript; None = leave that as it is."""
    radio = ctx.get("radio") or {}
    if _feed_state(ctx, channel["feedId"]) != "online":
        live = [c["name"] for c in _live(ctx, station)]
        instead = f" {_and(live)} {'is' if len(live) == 1 else 'are'} live." if live else ""
        return _reply(f"{channel['name']} on {station.get('name')} isn't playing on the Mac right now.{instead}")
    if radio.get("connected") == channel["feedId"] and (scope is None or radio.get("scope") == scope):
        return _reply(f"You're already on {channel['name']}.")
    action = {"type": "connect_feed", "feed": channel["feedId"]}
    if scope:
        action["scope"] = scope
    return _reply(f"{channel['name']} on {station.get('name')}{', and only that in the transcript' if scope == 'channel' else ''}.", action)


def _station_in(ctx: dict, words: str) -> tuple[dict, str] | None:
    """A controller named at the start of some words, and what follows it: "detroit arrival east" -> (Detroit, "arrival east")."""
    words = re.sub(r"^(the|to) ", "", words)
    for said in sorted(_NAMES, key=len, reverse=True):
        if words == said or words.startswith(said + " "):
            station = _named_station(ctx, said)
            if station:
                return station, words[len(said):].strip()
    return None


def _target(ctx: dict, words: str, scope: str | None) -> dict | None:
    """What "connect to <words>" / "switch to <words>" means: a controller, or one of a controller's channels."""
    named = _station_in(ctx, words)
    if named:
        station, rest = named
        if not rest or all(w in _FILLER for w in rest.split()):
            return _connect_station(ctx, station)
        found = _find_channel(ctx, rest, [station])
        return _connect_channel(ctx, station, found[1], scope) if found else None
    # A bare channel name: the controller being listened to first, then the one in view, then any.
    radio = ctx.get("radio") or {}
    for stations in ([_station_of(ctx, radio.get("connected"))], [ctx.get("station")], _stations(ctx)):
        stations = [_full(ctx, s) for s in stations if s]
        found = _find_channel(ctx, words, stations) if stations else None
        if found:
            return _connect_channel(ctx, found[0], found[1], scope)
    return None


def _full(ctx: dict, station: dict) -> dict:
    """The station as the radio list has it (the one in view arrives with less detail)."""
    return next((s for s in _stations(ctx) if s.get("id") == station.get("id")), station)


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
        rf"(?:can i |can we |let me |i want to |id like to )?(?:get )?(?:access|connect(?: me)?|listen(?: in)?|tune(?: in)?|hear|patch me in)(?: to| into| on)?(?: (.+?))?(?: frequency| channel)?",
        t,
    )
    if m:
        target = (m.group(1) or "").strip()
        if target and not re.fullmatch(_IT, target):
            # A controller by name, or one of its channels ("listen to Detroit arrival east"): that channel alone.
            return _target(ctx, target, "channel")
        if station:
            return _connect_station(ctx, _full(ctx, station))
        guess = _plane_radio(ctx)
        if guess:
            heard = f", and I heard it there {ago(guess['heardAgoS'])}" if guess.get("heardAgoS") is not None else ""
            known = next((s for s in _stations(ctx) if s.get("id") == guess.get("facility")), None)
            return _connect_station(ctx, known or {"name": guess.get("name") or "its controller", "feedId": guess.get("feedId")}, lead=f"It's probably on {guess.get('name')}{heard}. ")
        live = [s for s in _stations(ctx) if _live(ctx, s)]
        if len(live) == 1:
            return _connect_station(ctx, live[0])
        if live:
            return _reply("Point at a controller or a plane, or say which one: " + ", ".join(s["name"].split(" (")[0] for s in live[:4]) + ".")
        return _reply("No radio feed is playing on the Mac right now.")

    # --- Another channel of the controller being listened to, or another controller
    m = re.fullmatch(r"(?:switch|change|go|flip|move|jump)(?: over)? to (.+?)(?: frequency| channel)?|put on (.+?)|(?:give me|play) (.+?)", t)
    if m:
        found = _target(ctx, next(g for g in m.groups() if g), None)
        if found:
            return found
    here = _station_of(ctx, connected)
    if re.fullmatch(r"next (?:channel|frequency)|(?:the )?other (?:channel|one|frequency)|(?:switch|change) channels?|another channel", t):
        if not here or len(_channels(here)) < 2:
            return _reply("There's only one channel here." if here else "You're not connected to a frequency.")
        live = _live(ctx, here)
        if len(live) < 2:
            return _reply(f"Nothing else on {here['name']} is playing right now.")
        at = next((i for i, c in enumerate(live) if c["feedId"] == connected), -1)
        return _connect_channel(ctx, here, live[(at + 1) % len(live)], None)
    if re.fullmatch(r"(?:only|just) (?:this|that) (?:channel|one|frequency)|this (?:channel|one|frequency) only|(?:a )?single channel|only what im (?:hearing|listening to)", t):
        if not here:
            return _reply("You're not connected to a frequency.")
        return _reply("Only this channel in the transcript.", {"type": "radio_scope", "state": "one"})
    if re.fullmatch(r"all(?: the| of the)? channels|every channel|all of them|(?:show |give me )?everything (?:on|at|from) (?:it|this|here|.+)|the whole (?:airport|thing)", t):
        if not here:
            return _reply("You're not connected to a frequency.")
        if len(_channels(here)) < 2:
            return _reply(f"{here['name']} only has the one channel.")
        return _reply(f"All of {here['name']}'s channels in the transcript.", {"type": "radio_scope", "state": "all"})
    m = re.fullmatch(
        r"(?:which|what) channels? (?:does|do|has) (.+?) (?:have|got)|(?:which|what) channels?(?: are| is)?(?: there| live| on| playing| available| up)*(?: (?:at|on|for|in) (.+?))?|list(?: the)? channels(?: (?:at|on|for|in) (.+))?", t
    )
    if m:
        said = next((g for g in m.groups() if g), None)
        which = (_station_in(ctx, said) or (None,))[0] if said else None
        which = which or (station and _full(ctx, station)) or here
        if not which:
            return _reply("Point at a controller, or say which one.")
        chans, live = _channels(which), _live(ctx, which)
        if len(chans) < 2:
            return _reply(f"{which['name']} has one channel, and it {'is live' if live else 'is not playing right now'}.")
        off = [c["name"] for c in chans if c not in live]
        if not live:
            return _reply(f"{which['name']} has {len(chans)} channels, and none is playing right now: {_and(off)}.")
        up = f"{_and([c['name'] for c in live])} {'is' if len(live) == 1 else 'are'} live"
        return _reply(f"{which['name']}: {up}." + (f" Not playing: {_and(off)}." if off else ""))

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
            return _reply(f"Yes, {named['name']} is live." if _live(ctx, named) else f"No, {named['name']} isn't playing right now.")
    if re.fullmatch(r"(?:which|what) (?:feeds|frequencies|radios|controllers) (?:are|is) (?:live|online|up|on|playing|available)|whats live|what can i listen to", t):
        live = [s["name"] for s in _stations(ctx) if _live(ctx, s)]
        if not live:
            return _reply("No radio feed is playing on the Mac right now.")
        return _reply(("Live right now: " + ", ".join(live) + ".") if len(live) > 1 else f"Only {live[0]} is live right now.")
    return None
