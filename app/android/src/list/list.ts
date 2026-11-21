// The list view's state and what it shows: every plane the app knows about (out to 250 nm),
// filtered, sorted and paged, plus one plane opened for a closer look.
//
// This module holds no drawing code (see draw.ts) and no input handling (see main.ts). Its methods
// are the actions the voice assistant will call in Phase 3: show/hide, setFilter, clearFilter, sort,
// page, openRow, openPlane, count.

import { cardLines, cardTag } from '@web/format';
import { elevationDeg } from '@web/geo';
import type { Plane } from '@web/planes';
import { DEV_PRESETS, PAGE_SIZE, applyFilter, filterChips, matches, pageCount, sanitizeFilter } from './filter';
import type { ListFilter, SortKey, SortOrder } from './filter';

const M_PER_FT = 0.3048;
/** Ground traffic sits about this far below your eyes (same figure the sky markers use). */
const GROUND_TRAFFIC_BELOW_EYE_M = 1.7;
/** The rows are recomputed this often while the list is open (not every frame). */
const REFRESH_MS = 1000;

export type ListRow = {
  /** 1-based position on the page: what "open number 3" refers to. */
  n: number;
  plane: Plane;
  belowHorizon: boolean;
};

export type OpenedPlane = {
  plane: Plane;
  /** Status and/or fleet tag ("MEDICAL", "BGSU"), or null. */
  tag: string | null;
  /** Title, type and route, flight data, then where it is. */
  lines: string[];
  /** Within the AR radius: its bracket pulses and the compass points at it. */
  inAr: boolean;
  /** No longer in the data (flew out of range, landed and switched off...). */
  lost: boolean;
};

export type ListView = {
  /** e.g. "1,243 planes · 250 nm · 40s ago", or "12 of 1,187 planes · ..." with a filter. */
  header: string;
  chips: string[];
  rows: ListRow[];
  /** 0-based. */
  page: number;
  pages: number;
  /** Every plane that passes the filter, in list order: what the radar shows while the list is open. */
  matched: Plane[];
  opened: OpenedPlane | null;
};

export type ListDeps = {
  /** Every known plane, distances and bearings current. Called about once a second while open. */
  planes: () => Plane[];
  coverage: () => { radius: string; ageS: number | null; note: string };
  /** Your eye altitude in meters (same reference as Plane.altitudeGeomFt). */
  viewerAltM: () => number;
  arRadiusKm: () => number;
  /** Start a route lookup for one plane; `routeFor` returns it once it has arrived. */
  lookupRoute: (p: Plane) => void;
  routeFor: (callsign: string) => [string | null, string | null] | undefined;
  /** An extra line for a plane, e.g. its pattern leg ("Right downwind · RWY 28"), or null. */
  noteFor?: (id: string) => string | null;
};

const COMPASS_WORDS = [
  'north', 'north-northeast', 'northeast', 'east-northeast',
  'east', 'east-southeast', 'southeast', 'south-southeast',
  'south', 'south-southwest', 'southwest', 'west-southwest',
  'west', 'west-northwest', 'northwest', 'north-northwest',
];
export const compassWord = (bearingDeg: number) => COMPASS_WORDS[Math.round((((bearingDeg % 360) + 360) % 360) / 22.5) % 16];

const count = (n: number) => n.toLocaleString('en-US');

/** What the list calls a plane: the callsign as transmitted (what you'd hear on the radio), else the tail number. */
export const rowName = (p: Plane) => p.callsign?.trim() || p.registration || p.id.toUpperCase();

/** Angle above the horizon in degrees, or null if the plane's altitude is unknown. */
export function elevationOf(p: Plane, viewerAltM: number): number | null {
  if (p.onGround) return elevationDeg(-GROUND_TRAFFIC_BELOW_EYE_M, p.distanceKm);
  const ft = p.altitudeGeomFt ?? p.altitudeFt;
  return ft == null ? null : elevationDeg(ft * M_PER_FT - viewerAltM, p.distanceKm);
}

/** "312 km west-northwest · below horizon" / "14 km south · 21° above the horizon". */
export function whereIs(p: Plane, viewerAltM: number): string {
  const km = p.distanceKm < 10 ? p.distanceKm.toFixed(1) : String(Math.round(p.distanceKm));
  const elev = elevationOf(p, viewerAltM);
  const height = elev == null ? null : elev < 0 ? 'below horizon' : `${Math.round(elev)}° above the horizon`;
  return [`${km} km ${compassWord(p.bearingDeg)}`, height].filter(Boolean).join(' · ');
}

const tidy = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Finds a plane by what someone would call it: callsign ("SWA1234"), registration ("N901BG"), hex
 * id, or the tail end of either ("1BG"). Exact matches win; ties go to the closer plane.
 */
export function findPlane(planes: Plane[], query: string): Plane | null {
  const q = tidy(query);
  if (!q) return null;
  const names = (p: Plane) => [p.callsign, p.registration, p.id].filter(Boolean).map((s) => tidy(s!));
  const nearest = (list: Plane[]) => list.reduce<Plane | null>((a, b) => (!a || b.distanceKm < a.distanceKm ? b : a), null);
  return (
    nearest(planes.filter((p) => names(p).includes(q))) ??
    nearest(planes.filter((p) => names(p).some((n) => n.endsWith(q)))) ??
    nearest(planes.filter((p) => names(p).some((n) => n.includes(q))))
  );
}

export type PlaneList = ReturnType<typeof createList>;

export function createList(deps: ListDeps) {
  let open = false;
  let filter: ListFilter = {};
  let opened: { id: string; last: Plane } | null = null;
  let presetIndex = -1;
  let cached: { at: number; view: ListView } | null = null;

  const dirty = () => (cached = null);

  function build(): ListView {
    const all = deps.planes();
    const matched = applyFilter(all, filter);
    const pages = pageCount(matched.length);
    const page = Math.min(pages - 1, Math.max(0, filter.page ?? 0));
    const viewerAltM = deps.viewerAltM();
    const rows = matched.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((plane, i) => {
      const elev = elevationOf(plane, viewerAltM);
      return { n: i + 1, plane, belowHorizon: elev != null && elev < 0 };
    });

    const chips = filterChips(filter);
    // "of N": what the list would hold with no filter (ground traffic is hidden by default).
    const unfiltered = chips.length ? all.filter((p) => matches(p, {})).length : matched.length;
    const { radius, ageS, note } = deps.coverage();
    const header = [
      chips.length ? `${count(matched.length)} of ${count(unfiltered)} planes` : `${count(matched.length)} planes`,
      radius,
      note || (ageS == null ? null : `${ageS}s ago`),
    ]
      .filter(Boolean)
      .join(' · ');

    return { header, chips, rows, page, pages, matched, opened: buildOpened(all, viewerAltM) };
  }

  function buildOpened(all: Plane[], viewerAltM: number): OpenedPlane | null {
    if (!opened) return null;
    const now = all.find((p) => p.id === opened!.id);
    if (now) opened.last = now;
    const plane = { ...opened.last };
    const route = plane.callsign ? deps.routeFor(plane.callsign) : undefined;
    if (route) [plane.origin, plane.destination] = route;
    const [, type, stats] = cardLines(plane);
    // Same name as its row (SWA407, not the card's "WN 407"), so opening a row doesn't rename it.
    const title = [rowName(plane), plane.airline].filter(Boolean).join(' · ');
    // cardLines ends the stats with the distance; the location line below says it better.
    const flight = stats.split(' · ').slice(0, -1).join(' · ');
    const lost = !now;
    const inAr = !lost && plane.distanceKm <= deps.arRadiusKm();
    const note = lost ? null : (deps.noteFor?.(plane.id) ?? null);
    const lines = [title, type, flight, note, lost ? 'No longer in range' : whereIs(plane, viewerAltM)].filter((l): l is string => !!l);
    return { plane, tag: cardTag(plane), lines, inAr, lost };
  }

  function view(): ListView | null {
    if (!open) return null;
    const now = Date.now();
    if (!cached || now - cached.at >= REFRESH_MS) cached = { at: now, view: build() };
    return cached.view;
  }

  function openPlaneNow(plane: Plane) {
    opened = { id: plane.id, last: plane };
    open = true;
    deps.lookupRoute(plane);
    dirty();
  }

  return {
    isOpen: () => open,
    /** null while the list is closed. */
    view,
    /** For the voice assistant's context (Phase 3). */
    state: () => ({ open, filter: { ...filter }, openedId: opened?.id ?? null }),

    toggle() {
      open = !open;
      if (!open) opened = null;
      dirty();
    },
    /** Opens the list; with a filter, replaces the current one. */
    show(next?: unknown) {
      open = true;
      opened = null;
      if (next !== undefined) filter = sanitizeFilter(next);
      dirty();
    },
    hide() {
      open = false;
      opened = null;
      dirty();
    },
    /** Merges into the current filter and goes back to the first page (unless a page is given). */
    setFilter(partial: unknown) {
      const clean = sanitizeFilter(partial);
      filter = { ...filter, ...clean, page: clean.page ?? 0 };
      opened = null;
      dirty();
    },
    clearFilter() {
      filter = {};
      presetIndex = -1;
      opened = null;
      dirty();
    },
    sort(by: SortKey, order?: SortOrder) {
      filter = { ...filter, sort: by, order, page: 0 };
      if (!order) delete filter.order;
      dirty();
    },
    page(direction: 'next' | 'prev') {
      const pages = view()?.pages ?? 1;
      const current = Math.min(pages - 1, filter.page ?? 0);
      filter = { ...filter, page: Math.min(pages - 1, Math.max(0, current + (direction === 'next' ? 1 : -1))) };
      dirty();
    },
    /** Opens row `n` (1-based) of the page on screen. False if there's no such row. */
    openRow(n: number): boolean {
      const row = view()?.rows.find((r) => r.n === n);
      if (row) openPlaneNow(row.plane);
      return !!row;
    },
    /** Opens a plane by callsign / registration (see findPlane), anywhere in the data. */
    openPlane(query: string): Plane | null {
      const plane = findPlane(deps.planes(), query);
      if (plane) openPlaneNow(plane);
      return plane;
    },
    /** Back from an opened plane to the rows. */
    closePlane() {
      opened = null;
      dirty();
    },
    /** How many planes a filter matches, without touching the list ("any emergencies around?"). */
    count: (f: unknown) => applyFilter(deps.planes(), sanitizeFilter(f)).length,
    /** Dev mode: step through a few preset filters, then back to none. */
    cyclePreset() {
      presetIndex = presetIndex + 1 >= DEV_PRESETS.length ? -1 : presetIndex + 1;
      filter = presetIndex < 0 ? {} : { ...DEV_PRESETS[presetIndex] };
      opened = null;
      dirty();
    },
  };
}
