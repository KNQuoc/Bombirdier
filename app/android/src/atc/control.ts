// "Who is working this plane?" as something to see: every plane coloured by its controller.
//
// Three kinds of evidence, strongest first:
//   handoff  a controller was heard telling the plane to contact someone ("contact Detroit Approach
//            one two four point zero five"): it is with them now.
//   heard    the plane's callsign was heard on a controller's frequency.
//   guess    nothing heard: where it is and how high (whoControls.ts). Drawn fainter.
//
// There are no boundary lines here on purpose: the app doesn't have the real sector shapes, and who
// is actually talking to a plane is what a student needs to see anyway.

import { CLEVELAND_CENTER, COLUMBUS_APPROACH, DETROIT_APPROACH, FACILITIES, TOLEDO_APPROACH, WOOD_COUNTY_CTAF, facilityOfFeed } from './facilities';
import type { Facility } from './facilities';

/** What the Mac's radio parser found in a call (mac-server/radio_parse.py handoff()). */
export type Handoff = {
  /** tower | ground | approach | departure | center | clearance | ramp | advisory */
  kind: string;
  /** "detroit", "cleveland", "indy": as said, or null ("contact tower"). */
  place: string | null;
  /** "124.05", or null when it wasn't said or wasn't understood. */
  freq: string | null;
};

export type Control = {
  /** null = someone the app has no entry for ("Indy Center"). */
  facility: Facility | null;
  /** "Detroit Approach 124.05": what to call them. */
  name: string;
  evidence: 'heard' | 'handoff' | 'guess';
};

type Rgb = [number, number, number];
/** One colour per controller. None of them is a status colour (red, grey, purple, green) or the focus yellow. */
const RGB: Record<string, Rgb> = {
  [CLEVELAND_CENTER.id]: [79, 195, 247],
  [DETROIT_APPROACH.id]: [255, 111, 181],
  [TOLEDO_APPROACH.id]: [46, 230, 200],
  [COLUMBUS_APPROACH.id]: [255, 138, 101],
  [WOOD_COUNTY_CTAF.id]: [255, 255, 255],
};
const SOMEONE_ELSE: Rgb = [176, 190, 197];
/** A guess is the same colour, fainter. */
const GUESS_ALPHA = 0.5;

/** Short enough for the legend. */
const SHORT: Record<string, string> = {
  [CLEVELAND_CENTER.id]: 'Cleveland Center',
  [DETROIT_APPROACH.id]: 'Detroit',
  [TOLEDO_APPROACH.id]: 'Toledo',
  [COLUMBUS_APPROACH.id]: 'Columbus',
  [WOOD_COUNTY_CTAF.id]: 'Wood County (no tower)',
};
export const shortName = (f: Facility | null) => (f ? (SHORT[f.id] ?? f.name) : 'Someone else');

const rgba = ([r, g, b]: Rgb, a: number) => `rgba(${r}, ${g}, ${b}, ${a})`;

/** The colour of a controller, at full strength. */
export const facilityColor = (f: Facility | null) => rgba(f ? (RGB[f.id] ?? SOMEONE_ELSE) : SOMEONE_ELSE, 1);

/** A plane's colour in the airspace view: its controller's, fainter when that is only a guess. */
export function controlColor(c: Control | null): string {
  if (!c) return rgba(SOMEONE_ELSE, GUESS_ALPHA);
  return rgba(c.facility ? (RGB[c.facility.id] ?? SOMEONE_ELSE) : SOMEONE_ELSE, c.evidence === 'guess' ? GUESS_ALPHA : 1);
}

/** Words in a handoff that name one of our controllers. Center only for Cleveland; the airports for everything but Center. */
const PLACES: { facility: Facility; words: string[]; center: boolean }[] = [
  { facility: CLEVELAND_CENTER, words: ['cleveland'], center: true },
  { facility: DETROIT_APPROACH, words: ['detroit', 'metro'], center: false },
  { facility: TOLEDO_APPROACH, words: ['toledo'], center: false },
  { facility: COLUMBUS_APPROACH, words: ['columbus'], center: false },
];

const title = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
const sameFreq = (a: string, b: string) => Math.abs(parseFloat(a) - parseFloat(b)) < 0.0005;

type FeedRef = { id: string; facility: string; freqs: string[] };

/**
 * Who a handoff sends a plane to. `from` is the controller that said it.
 *   by frequency   a feed (or a controller) that has it
 *   by name        "Detroit Approach", "Cleveland Center", "Toledo Tower"
 *   no name        "contact tower", "contact departure": the same airport as the one talking;
 *                  "contact center" from Detroit or Toledo is Cleveland Center
 * Anyone else ("Indy Center") is known by name only.
 */
export function resolveHandoff(h: Handoff, from: Facility | null, feeds: FeedRef[] = []): { facility: Facility | null; name: string } {
  const isCenter = h.kind === 'center';
  let facility: Facility | null = null;
  if (h.freq) {
    const feed = feeds.find((f) => f.freqs.some((x) => sameFreq(x, h.freq!)));
    facility = facilityOfFeed(feed) ?? FACILITIES.find((f) => f.freqs.some((x) => sameFreq(x, h.freq!))) ?? null;
  }
  const words = h.place?.split(' ') ?? [];
  if (!facility && words.length) facility = PLACES.find((p) => p.center === isCenter && p.words.some((w) => words.includes(w)))?.facility ?? null;
  if (!facility && !words.length && from) {
    if (!isCenter && from.kind === 'approach') facility = from;
    else if (isCenter && (from === DETROIT_APPROACH || from === TOLEDO_APPROACH)) facility = CLEVELAND_CENTER;
  }
  // Named as it was said; an unnamed "tower" somewhere else gets its airport in front.
  const place = h.place ? title(h.place) : facility && facility !== from && !isCenter ? shortName(facility) : isCenter && facility ? 'Cleveland' : null;
  return { facility, name: [place, title(h.kind), h.freq].filter(Boolean).join(' ') };
}

/** A pilot reads the instruction back on the old frequency: that doesn't put the plane back there. */
const READBACK_MS = 30_000;

/** The controller working a plane, from the best evidence there is. Times are Date.now() values. */
export function controlOf(o: {
  guess: Facility | null;
  heard: { facility: Facility; feedId: string; at: number } | null;
  handed: { to: Facility | null; name: string; fromFeedId: string; at: number } | null;
}): Control | null {
  const { guess, heard, handed } = o;
  if (handed && (!heard || handed.at >= heard.at || (heard.feedId === handed.fromFeedId && heard.at - handed.at < READBACK_MS))) {
    return { facility: handed.to, name: handed.name, evidence: 'handoff' };
  }
  if (heard) return { facility: heard.facility, name: heard.facility.name, evidence: 'heard' };
  return guess ? { facility: guess, name: guess.name, evidence: 'guess' } : null;
}

export type LegendRow = { color: string; label: string; count: number; heard: number };

/** The legend: one row per controller with planes in view, most planes first; "someone else" last. */
export function legendRows(controls: (Control | null)[]): LegendRow[] {
  const rows = new Map<string, LegendRow & { other: boolean }>();
  for (const c of controls) {
    const key = c?.facility?.id ?? '';
    const row = rows.get(key) ?? { color: facilityColor(c?.facility ?? null), label: shortName(c?.facility ?? null), count: 0, heard: 0, other: !key };
    row.count++;
    if (c && c.evidence !== 'guess') row.heard++;
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => Number(a.other) - Number(b.other) || b.count - a.count).map(({ other: _other, ...row }) => row);
}
