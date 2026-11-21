// "Who is this plane probably talking to?"
//
// ADS-B doesn't say which frequency a plane is tuned to, so this is a guess from where the plane is
// and how high. The boundaries are rough stand-ins for real airspace, which is why the HUD and the
// assistant say "likely". A call actually heard on a feed (radio.ts) is evidence and replaces the guess.

import type { Plane } from '@web/planes';
import { bearingDeg, haversineKm } from '../flights/geo';
import { CLEVELAND_CENTER, COLUMBUS_APPROACH, DETROIT_APPROACH, TOLEDO_APPROACH, WOOD_COUNTY_CTAF } from './facilities';
import type { Facility } from './facilities';

const KM_PER_NM = 1.852;
/** At Wood County: on the ground this close, or in the air this close and below this altitude. */
const CTAF_GROUND_KM = 3;
const CTAF_AIR_KM = 5;
const CTAF_BELOW_FT = 3000;
/** An approach control works roughly this far out and up to roughly this high. */
const APPROACH_NM = 40;
const APPROACH_BELOW_FT = 10_000;
/** The Bluffton High sector (the one feed for Cleveland Center): high traffic over northwest Ohio. */
const BLUFFTON = { lat: 40.9, lon: -83.9 };
const BLUFFTON_NM = 70;
const HIGH_SECTOR_FT = 24_000;
/** A rough box around Cleveland Center's airspace (Michigan's east side, northern Ohio, western PA and NY). */
const ZOB = { south: 39.6, north: 44.5, west: -85.2, east: -76.5 };

export type RadioGuess = {
  facility: Facility;
  /** The frequency, when the position narrows it down to one. */
  freq: string | null;
};

type Where = Pick<Plane, 'lat' | 'lon' | 'altitudeFt' | 'onGround'> & { altitudeGeomFt?: number | null };

const kmTo = (p: Where, f: { lat: number; lon: number }) => haversineKm(p.lat, p.lon, f.lat, f.lon);

/** The controller a plane is probably talking to, or null when it's outside everything we know. */
export function whoControls(p: Where): RadioGuess | null {
  const alt = p.altitudeFt ?? p.altitudeGeomFt ?? null;
  const home = kmTo(p, WOOD_COUNTY_CTAF.position);
  if ((p.onGround && home <= CTAF_GROUND_KM) || (!p.onGround && home <= CTAF_AIR_KM && alt != null && alt < CTAF_BELOW_FT)) {
    return { facility: WOOD_COUNTY_CTAF, freq: WOOD_COUNTY_CTAF.freqs[0] };
  }

  // The nearest approach control whose airspace the plane is plausibly in.
  const low = p.onGround || (alt != null && alt < APPROACH_BELOW_FT);
  if (low) {
    const near = [TOLEDO_APPROACH, DETROIT_APPROACH, COLUMBUS_APPROACH]
      .map((f) => ({ f, km: kmTo(p, f.position) }))
      .filter((x) => x.km <= APPROACH_NM * KM_PER_NM)
      .sort((a, b) => a.km - b.km)[0];
    if (near?.f === TOLEDO_APPROACH) {
      const from = bearingDeg(TOLEDO_APPROACH.position.lat, TOLEDO_APPROACH.position.lon, p.lat, p.lon);
      return { facility: TOLEDO_APPROACH, freq: from < 180 ? '126.1' : '134.35' };
    }
    // Detroit and Columbus split their airspace into many sectors: which one isn't guessed.
    if (near) return { facility: near.f, freq: null };
  }

  if (p.lat >= ZOB.south && p.lat <= ZOB.north && p.lon >= ZOB.west && p.lon <= ZOB.east) {
    const high = alt != null && alt >= HIGH_SECTOR_FT && kmTo(p, BLUFFTON) <= BLUFFTON_NM * KM_PER_NM;
    return { facility: CLEVELAND_CENTER, freq: high ? CLEVELAND_CENTER.freqs[0] : null };
  }
  return null;
}

/** "40s ago", "3 min ago". */
export function agoShort(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return s < 90 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
}

/**
 * The radio line of a plane's card.
 *   heard on a feed:   "📻 Toledo Approach 126.1 · ✅ heard 40s ago"   (evidence, so no "Likely")
 *   a guess:           "📻 Likely Toledo Approach 126.1"
 *   nothing to hear:   "📻 Likely Fort Wayne Approach · no live feed"
 */
export function radioLine(guess: RadioGuess | null, heard: { facility: Facility; agoS: number } | null): string | null {
  if (heard) {
    // The frequency is only known if the guess agrees about who it is.
    const freq = guess?.facility.id === heard.facility.id ? guess.freq : heard.facility.freqs.length === 1 ? heard.facility.freqs[0] : null;
    return `📻 ${[heard.facility.name, freq].filter(Boolean).join(' ')} · ✅ heard ${agoShort(heard.agoS)}`;
  }
  if (!guess) return null;
  const who = `📻 Likely ${[guess.facility.name, guess.freq].filter(Boolean).join(' ')}`;
  return guess.facility.feedId ? who : `${who} · no live feed`;
}
