// Which planes belong to the BGSU flight program, whose home field is Wood County (1G0).
// They're the planes this app is mostly for, so they get a tag, their own color and a list filter.
//
// ADS-B data doesn't name the owner, so this goes by tail number: BGSU registers its trainers as
// N<digits>BG (seen live: N337BG, a Piper Archer; N442BG, a Piper Seminole). The suffix alone isn't
// enough (N501BG is a CRJ-700), so the aircraft also has to be a propeller plane, or of unknown type.

import type { Plane } from '@web/planes';
import { engineKind } from '../list/kind';

export const BGSU_TAG = 'BGSU';
/** BGSU orange, lightened a little so thin strokes read against a bright sky. */
export const BGSU_COLOR = '#ff8a3d';

/**
 * Tail numbers known to be BGSU's, matched whatever the type says. Add to this when the fleet list
 * is confirmed: it is more reliable than the pattern below.
 */
const KNOWN_TAILS = new Set<string>(['N337BG', 'N442BG']);
const TAIL_PATTERN = /^N\d{1,3}BG$/;

export function isBgsu(p: Plane): boolean {
  // GA planes usually transmit their tail number as the callsign, so either field will do.
  const tail = (p.registration ?? p.callsign ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (KNOWN_TAILS.has(tail)) return true;
  if (!TAIL_PATTERN.test(tail) || p.kind === 'helicopter') return false;
  return p.typeCode == null || engineKind(p) === 'prop';
}

/** Marks BGSU planes in place (Plane.tag + Plane.accent) so the HUD and the list show them as such. */
export function tagFleet(planes: Plane[]): Plane[] {
  for (const p of planes) {
    if (isBgsu(p)) {
      p.tag = BGSU_TAG;
      p.accent = BGSU_COLOR;
    }
  }
  return planes;
}
