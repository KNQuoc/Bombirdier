"""Tests for the radio side that need no audio, no network and no model: the call parser and the call splitter.

    python3 test_radio.py
"""
import radio_parse as R

passed = failed = 0


def check(name, actual, expected):
    global passed, failed
    if actual == expected:
        passed += 1
    else:
        failed += 1
        print(f"FAIL {name}\n  got      {actual!r}\n  expected {expected!r}")


def tokens(text):
    return R.callsign_tokens(text)


# Airline radio names, however Whisper writes the number.
check("grouped words", tokens("Delta eighteen thirty, descend and maintain four thousand."), ["DAL1830"])
check("digits", tokens("Delta 1830, descend and maintain 4,000."), ["DAL1830"])
check("digit by digit", tokens("American two eight niner one, turn left heading two seven zero."), ["AAL2891"])
check("three digits", tokens("United four fifty six, contact Cleveland Center one two four point seven."), ["UAL456"])
check("two word name", tokens("Blue Streak fifty two forty, Toledo Approach, radar contact."), ["JIA5240"])
check("spelled callsign", tokens("Brickyard 3472 climb and maintain one zero thousand"), ["RPA3472"])
check("southwest", tokens("Southwest 407 heavy traffic twelve o'clock"), ["SWA407"])
check("fedex with letters after", tokens("FedEx one forty seven heavy, cleared direct"), ["FDX147"])
check("skywest suffix letter", tokens("SkyWest four sixty seven foxtrot, descend at pilot's discretion"), ["SKW467F"])
check("already written out", tokens("DAL1830 descend and maintain 4000"), ["DAL1830"])
check("two aircraft in one call", tokens("Delta 1830, follow the Southwest 737 ahead, Southwest 407 is on final"), ["DAL1830", "SWA407"])
check("delta the airline, not the letter", tokens("Delta 22, expect vectors"), ["DAL22"])
check("no number, no callsign", tokens("Good evening Delta, standby"), [])
check("an altitude is not a flight number", tokens("Descend and maintain four thousand, altimeter three zero two six"), [])

# Tail numbers.
check("november spelled out", tokens("November three three seven Bravo Golf, traffic two o'clock, five miles."), ["N337BG"])
check("november with digits", tokens("November 337 Bravo Golf, radar contact"), ["N337BG"])
check("whisper style dashes", tokens("November 3-4-0 Bravo Golf, say altitude"), ["N340BG"])
check("written out", tokens("N442BG, cleared for the option"), ["N442BG"])
check("type and tail", tokens("Archer niner zero one Bravo Golf, left downwind runway two eight"), ["901BG"])
check("type and short tail", tokens("Seminole four two Bravo Golf, turning base"), ["42BG"])
check("skyhawk digits", tokens("Skyhawk 734 Lima Sierra, Wood County traffic"), ["734LS"])
check("type then november", tokens("Cessna November one two three four Alpha, squawk four five two one"), ["N1234A"])
check("delta inside a tail is a letter", tokens("November one two Delta Bravo, turn right"), ["N12DB"])
check("nothing to find", tokens("Wood County traffic, wind check please"), [])
check("a type word alone", tokens("Follow the Archer on final"), [])
check("empty", tokens(""), [])

# Position reports.
check("left downwind 28", R.position_report("Archer 901 Bravo Golf, left downwind runway two eight, Wood County"), ("left downwind", "28"))
check("right base", R.position_report("Wood County traffic, Seminole 442BG turning right base runway 28"), ("right base", "28"))
check("final, runway digits", R.position_report("Skyhawk four lima sierra, short final runway one eight, full stop"), ("final", "18"))
check("upwind", R.position_report("Archer one bravo golf, upwind runway one zero, staying in the pattern"), ("upwind", "10"))
check("crosswind no runway", R.position_report("Bowling Green traffic, Cherokee turning crosswind"), ("crosswind", None))
check("runway only", R.position_report("Delta 1830, cleared ILS runway two five approach"), (None, "25"))
check("parallel runway", R.position_report("Cleared to land runway two seven left"), (None, "27L"))
check("final approach fix is not a leg", R.position_report("Delta 1830, cross the final approach fix at three thousand"), (None, None))
check("base as a noun is not a leg", R.position_report("Returning to base, request frequency change"), (None, None))
check("nothing", R.position_report("Radar contact, say altitude"), (None, None))

check("parse puts it together", R.parse("Archer niner zero one Bravo Golf, left downwind runway two eight"),
      {"callsignTokens": ["901BG"], "reportedLeg": "left downwind", "runway": "28"})

check("spoken form: airline", R.spoken_form("DAL1830"), "Delta 1830")
check("spoken form: tail", R.spoken_form("N337BG"), "November 337 Bravo Golf")
check("spoken form: unknown", R.spoken_form("XYZ12"), "XYZ12")

# ---- call splitter: made-up audio (a tone for speech, near-silence between) ----
import math
import random
import struct

from splitter import SAMPLE_RATE, CallSplitter

random.seed(7)


def tone(seconds, amplitude=6000):
    n = int(SAMPLE_RATE * seconds)
    return b"".join(struct.pack("<h", int(amplitude * math.sin(2 * math.pi * 440 * i / SAMPLE_RATE))) for i in range(n))


def hiss(seconds, amplitude=40):
    return b"".join(struct.pack("<h", random.randint(-amplitude, amplitude)) for _ in range(int(SAMPLE_RATE * seconds)))


def split(audio, chunk=4800):
    s = CallSplitter()
    calls = []
    for i in range(0, len(audio), chunk):
        calls += s.feed(audio[i : i + chunk])
    return [round(len(c) / (SAMPLE_RATE * 2), 1) for c in calls]


check("two calls with a gap", split(hiss(1) + tone(2.0) + hiss(1.5) + tone(1.2) + hiss(1.5)), [2.4, 1.6])
check("a short pause is the same call", split(hiss(1) + tone(1.0) + hiss(0.3) + tone(1.0) + hiss(1.5)), [2.7])
check("a click is not a call", split(hiss(1) + tone(0.2) + hiss(2)), [])
check("silence only", split(hiss(5)), [])
check("still open at the end: not handed over yet", split(hiss(1) + tone(2.0)), [])
check("a stuck channel is cut", [len(split(hiss(1) + tone(27) + hiss(1.5))), split(hiss(1) + tone(27) + hiss(1.5))[0]], [2, 25.0])
check("chunk size does not matter", split(hiss(1) + tone(2.0) + hiss(1.5), chunk=333), split(hiss(1) + tone(2.0) + hiss(1.5), chunk=16000))
# A steady background (an open channel with engine noise) and speech over it.
check("speech over steady noise", split(hiss(2, 400) + tone(1.5, 5000) + hiss(2, 400)), [1.9])

# --- From real calls (2026-11-21)
check("flight number ends at the sentence", tokens("Skywest 4129. Seven finishes. Stay away."), ["SKW4129"])
check("tail fragment written in one piece", tokens("Skyhawk 570U, form contact Cleveland Center 124.4."), ["570U"])
check("number groups still join inside a clause", tokens("Delta 18 30, descend and maintain 4,000."), ["DAL1830"])
check("a comma ends the flight number", tokens("United 12, 34 heavy"), ["UAL12"])

print(f"{passed} passed, {failed} failed")
raise SystemExit(1 if failed else 0)
