"""Make Bombirdier's airfield lists from OurAirports' airports.csv (public domain, ourairports.com).

    python3 build_airports.py /path/to/airports.csv

Writes two files, both lists of rows [code, name, city, lat, lon, elevationFt, kind]:

    mac-server/data/airports.json                    every airfield in the US and Canada
    app/android/src/airports/region-airports.json    those within REGION_NM of Wood County

kind: "L" large, "M" medium, "S" small public-use, "P" private strip, "H" heliport.

OurAirports doesn't say whether a field is public or private. In the US the FAA's identifiers do:
private-use fields get four characters with the state's letters in them ("OH23", "7OH5"), public
ones three ("1G0", "TOL"). That is the rule used here; it matters because a plane first seen two
miles from a public airport is far likelier to have left from it than from a farm strip next door.

The csv is about 13 MB and is not kept in the project: download it, run this, delete it.
"""
import csv
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MAC_OUT = os.path.join(HERE, "data", "airports.json")
APP_OUT = os.path.join(HERE, "..", "app", "android", "src", "airports", "region-airports.json")
HOME = (41.391, -83.6301)  # Wood County (1G0)
REGION_NM = 350  # the phone watches 250 nm around the viewer; this leaves room for standing elsewhere
KINDS = {"large_airport": "L", "medium_airport": "M", "small_airport": "S", "heliport": "H"}


def distance_nm(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 3440.065 * 2 * math.asin(math.sqrt(a))


def rows(path):
    with open(path, encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            kind = KINDS.get(r["type"])
            if not kind or r["iso_country"] not in ("US", "CA"):
                continue
            try:
                lat, lon = float(r["latitude_deg"]), float(r["longitude_deg"])
            except ValueError:
                continue
            code = (r["local_code"] or r["iata_code"] or r["gps_code"] or r["ident"]).strip().upper()
            name = " ".join(r["name"].split())
            if not code or not name:
                continue
            if kind == "S" and r["iso_country"] == "US" and len(code) == 4:
                kind = "P"
            elev = r["elevation_ft"].strip()
            yield [code, name, " ".join(r["municipality"].split()), round(lat, 4), round(lon, 4), int(float(elev)) if elev else None, kind]


def write(path, items):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write("[\n" + ",\n".join(json.dumps(i, ensure_ascii=False, separators=(",", ":")) for i in items) + "\n]\n")
    return os.path.getsize(path)


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    everything = sorted(rows(sys.argv[1]), key=lambda r: (r[0], r[1]))
    region = [r for r in everything if distance_nm(HOME[0], HOME[1], r[3], r[4]) <= REGION_NM]
    for label, path, items in (("US and Canada", MAC_OUT, everything), (f"within {REGION_NM} nm of Wood County", APP_OUT, region)):
        size = write(path, items)
        counts = {k: sum(1 for i in items if i[6] == k) for k in "LMSPH"}
        print(f"{label}: {len(items)} airfields, {size / 1e6:.2f} MB, {counts} -> {os.path.relpath(path, HERE)}")


if __name__ == "__main__":
    main()
