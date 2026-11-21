"""What Aivana is told: who it is, and what's around the user right now."""
from speech import compass_word, feet, miles
from tools import describe_for_prompt

SYSTEM = f"""You are the hands-free voice assistant in Bombirdier, an AR aviation headset app used at Wood County
Regional Airport (1G0) in Bowling Green, Ohio, home of the BGSU flight program. The user is looking at the sky
through the headset and just spoke to you.

How to answer:
- Like a knowledgeable co-pilot, not a teacher. Answer the question directly. No preamble, no praise, no quizzing,
  no lessons. Explain only when asked why or how.
- Your answer is read aloud: plain spoken English, 1 or 2 short sentences, 3 at most. No markdown, lists, emojis
  or abbreviations that sound odd spoken.
- The context in the user's message is the source of truth for what is around. Don't invent callsigns, routes,
  positions or altitudes that aren't in it. If you don't know, say so briefly.
- General aviation knowledge is fine for questions the context can't answer (aircraft types, procedures, airlines).
- Distances in the context are nautical miles; say "miles".
- "That plane", "it", "this one" mean the plane under "Looking at" (or "Opened from the list" if nothing is being looked at).
- Arrival and departure times in the context are estimates from the plane's position and speed. Say "about" and
  never present them as the airline's schedule. Weather lines are real current reports, and forecast lines are the
  official airport forecast: read from them, don't add to them, and never say whether it is safe to fly.
- Radio calls in the context are machine transcripts of live air traffic control. When asked what was said, put it
  in plain English and say if you're unsure of a word. "Probably talking to" is a guess from the plane's position.
- A helicopter is a helicopter, never a plane. Mention emergency, military or medical status when it's there.

{describe_for_prompt()}

Reply with JSON: `answer` is what you say out loud, `actions` is the list of actions to carry out."""


def _plane_line(p: dict) -> str:
    name = p.get("callsign") or p.get("registration") or p.get("id") or "unknown"
    bits = [name]
    kind = p.get("typeName") or p.get("typeCode") or ("helicopter" if p.get("kind") == "helicopter" else None)
    if p.get("tag"):
        bits.append(p["tag"])
    if kind:
        bits.append(kind)
    if p.get("airline"):
        bits.append(p["airline"])
    if p.get("origin") and p.get("destination"):
        bits.append(f"{p['origin']} to {p['destination']}")
    if p.get("onGround"):
        bits.append("on the ground")
    elif p.get("altitudeFt") is not None:
        rate = p.get("verticalRateFpm") or 0
        bits.append(feet(p["altitudeFt"]) + (" climbing" if rate >= 300 else " descending" if rate <= -300 else ""))
    if p.get("groundSpeedKt") is not None:
        bits.append(f"{round(p['groundSpeedKt'])} knots")
    if p.get("distanceKm") is not None and p.get("bearingDeg") is not None:
        bits.append(f"{miles(p['distanceKm'])} {compass_word(p['bearingDeg'])}")
    if p.get("leg"):
        bits.append(p["leg"])
    for flag in ("emergency", "military", "medical"):
        if p.get(flag):
            bits.append(flag if flag != "emergency" else f"EMERGENCY ({p[flag]})")
    radio = p.get("radio") or {}
    if radio.get("name"):
        heard = f", heard there {radio['heardAgoS']} s ago" if radio.get("heardAgoS") is not None else ", not heard on the radio"
        bits.append(f"probably talking to {radio['name']}{' ' + str(radio['freq']) if radio.get('freq') else ''}{heard}")
    # What was actually said in the calls that named it (machine transcripts), oldest first.
    calls = [c for c in (radio.get("calls") or []) if isinstance(c, dict) and c.get("text")][-3:]
    if calls:
        bits.append("radio calls naming it: " + "; ".join(f"[{c.get('agoS')} s ago{', ' + str(c['on']) if c.get('on') else ''}] \"{str(c['text'])[:200]}\"" for c in calls))
    return ", ".join(bits)


def _radio_lines(ctx: dict) -> list[str]:
    """The radio as the assistant should know it: what's live, what the user is on, what was just said."""
    lines: list[str] = []
    feeds = {f.get("id"): f for f in ctx.get("feeds") or []}
    radio = ctx.get("radio") or {}
    stations = radio.get("stations") or []
    if stations:
        parts = []
        for s in stations:
            chans = [c for c in s.get("channels") or [] if c.get("feedId")] or ([{"feedId": s["feedId"], "name": None}] if s.get("feedId") else [])
            if not chans:
                parts.append(f"{s.get('name')} (no feed)")
                continue
            # A controller with several frequencies lists each as a channel with its own feed id.
            listed = [f"{(c['name'] + ': ') if c.get('name') and len(chans) > 1 else ''}feed id {c['feedId']}, {'live' if (feeds.get(c['feedId']) or {}).get('status') == 'online' else 'not playing'}" for c in chans]
            parts.append(f"{s.get('name')} ({'; '.join(listed)})")
        lines.append("Radio feeds: " + "; ".join(parts) + ".")
    station = ctx.get("station")
    if station:
        lines.append(f"Looking at the controller: {station.get('name')}, frequencies {', '.join(map(str, station.get('freqs') or []))}.")
    connected = radio.get("connected")
    if connected:
        name = (feeds.get(connected) or {}).get("name") or connected
        scope = ", every channel of that controller in the transcript" if radio.get("scope") == "facility" else ""
        lines.append(f"Radio: listening to {name}, audio {'on' if radio.get('audio') else 'muted'}, transcript {'shown' if radio.get('transcript') else 'hidden'}{scope}.")
    elif stations:
        lines.append("Radio: not connected to a frequency.")
    recent = ctx.get("radioRecent") or []
    if recent:
        where = "on that frequency" if connected else "on the radio (all feeds)"
        lines.append(f"Recent calls {where}, oldest first (machine transcripts, may contain errors):")
        lines += [f"  {e.get('agoS')} s ago{'' if connected else ' on ' + str((feeds.get(e.get('feedId')) or {}).get('name') or e.get('feedId'))}: {e.get('text')}" for e in recent[-8:]]
    return lines


def context_text(ctx: dict) -> str:
    """The phone's context as a few plain lines. Missing parts are simply left out."""
    lines: list[str] = []
    airport = ctx.get("airport") or {}
    if airport:
        where = f"{miles(airport.get('distanceKm'))} from" if (airport.get("distanceKm") or 0) > 1 else "at"
        lines.append(
            f"User is {where} {airport.get('name', 'the airport')} ({airport.get('ident', '')}). Runway in use: {airport.get('activeRunway')}"
            f" ({airport.get('patternSide')} traffic; {airport.get('runwaySource') or 'set in the app'}), pattern altitude {airport.get('tpaFtMsl')} ft, field elevation {airport.get('elevationFt')} ft."
        )
    focus = ctx.get("focus")
    lines.append(f"Looking at: {_plane_line(focus)}" if focus else "Looking at: no plane in the middle of the view.")
    if ctx.get("opened") and not focus:
        lines.append(f"Opened from the list (what \"it\" means now): {_plane_line(ctx['opened'])}")
    others = [p for p in ctx.get("inView") or [] if not focus or p.get("id") != focus.get("id")]
    if others:
        lines.append("Also in view: " + "; ".join(_plane_line(p) for p in others[:5]))
    bgsu = ctx.get("bgsu") or []
    lines.append("BGSU planes flying: " + ("; ".join(_plane_line(p) for p in bgsu[:5]) if bgsu else "none seen right now."))
    if ctx.get("arRadiusKm"):
        lines.append(f"The compass bar and the sky show planes within {round(ctx['arRadiusKm'])} km (ar_range changes it; the list covers everything farther out).")
    if ctx.get("skyFilter"):
        lines.append(f"Sky filter on: only planes matching {ctx['skyFilter']} are shown on the compass bar and in the sky (sky_filter with no filter shows everything again).")
    traffic = ctx.get("traffic") or {}
    if traffic.get("total") is not None:
        lines.append(f"Traffic known: {traffic['total']} aircraft within {traffic.get('radiusNm', 250)} miles.")
    lst = ctx.get("list") or {}
    if lst.get("open"):
        rows = "; ".join(f"{r.get('n')}: {r.get('name')} {r.get('type') or ''}".strip() for r in lst.get("rows") or [])
        lines.append(f"Plane list: open, filter {lst.get('filter') or {}}, {lst.get('matched')} matching, page {lst.get('page')} of {lst.get('pages')}. Rows: {rows}")
        if lst.get("opened"):
            lines.append(f"Opened from the list: {lst['opened']}")
    else:
        lines.append("Plane list: closed.")
    lines += _radio_lines(ctx)
    return "\n".join(lines)
