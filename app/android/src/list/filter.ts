// The list's filter model. Plain JSON on purpose: the voice assistant (Phase 3) sets it from a tool
// call, so sanitizeFilter() accepts untrusted input and keeps only what's valid.

import type { Plane } from '@web/planes';
import { KM_PER_NM } from '../flights/nearby';
import { BGSU_TAG } from '../fleet/bgsu';
import { engineKind } from './kind';

export const LIST_KINDS = ['jets', 'props', 'helicopters', 'military', 'medical', 'emergencies'] as const;
export type ListKind = (typeof LIST_KINDS)[number];
export const SORT_KEYS = ['distance', 'altitude', 'speed'] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type SortOrder = 'asc' | 'desc';
/** Aircraft on the ground: left out (default), mixed in, or the only thing shown. */
export type GroundMode = 'hide' | 'show' | 'only';

export type ListFilter = {
  /** Only the home fleet: BGSU's trainers. Includes ones on the ground unless `onGround` says otherwise. */
  fleet?: 'bgsu';
  kind?: ListKind;
  /** ICAO airline code, e.g. "SWA": matches callsigns like SWA1234. */
  airline?: string;
  /** ICAO type designator, e.g. "B738". */
  typeCode?: string;
  minAltFt?: number;
  maxAltFt?: number;
  minDistNm?: number;
  maxDistNm?: number;
  climbing?: boolean;
  descending?: boolean;
  onGround?: GroundMode;
  /** Callsign / registration substring. */
  query?: string;
  sort?: SortKey;
  order?: SortOrder;
  /** 0-based. */
  page?: number;
};

export const PAGE_SIZE = 8;
/** Vertical rates smaller than this are level flight (matches the info card). */
const LEVEL_FPM = 150;

const text = (v: unknown, max: number): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = v.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
  return t ? t.slice(0, max) : undefined;
};
const amount = (v: unknown, max: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(max, v) : undefined;
const oneOf = <T extends string>(v: unknown, options: readonly T[]): T | undefined =>
  options.includes(v as T) ? (v as T) : undefined;

/** Keeps the valid fields of anything filter-shaped; everything else is dropped. */
export function sanitizeFilter(input: unknown): ListFilter {
  const f = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out: ListFilter = {
    fleet: oneOf(f.fleet, ['bgsu'] as const),
    kind: oneOf(f.kind, LIST_KINDS),
    airline: text(f.airline, 3),
    typeCode: text(f.typeCode, 4),
    minAltFt: amount(f.minAltFt, 100_000),
    maxAltFt: amount(f.maxAltFt, 100_000),
    minDistNm: amount(f.minDistNm, 1000),
    maxDistNm: amount(f.maxDistNm, 1000),
    climbing: f.climbing === true ? true : undefined,
    descending: f.descending === true ? true : undefined,
    onGround: oneOf(f.onGround, ['hide', 'show', 'only'] as const),
    query: text(f.query, 12),
    sort: oneOf(f.sort, SORT_KEYS),
    order: oneOf(f.order, ['asc', 'desc'] as const),
    page: typeof f.page === 'number' && Number.isInteger(f.page) && f.page >= 0 ? f.page : undefined,
  };
  for (const k of Object.keys(out) as (keyof ListFilter)[]) if (out[k] === undefined) delete out[k];
  return out;
}

function matchesKind(p: Plane, kind: ListKind): boolean {
  switch (kind) {
    case 'jets':
      return engineKind(p) === 'jet';
    case 'props':
      return engineKind(p) === 'prop';
    case 'helicopters':
      return p.kind === 'helicopter';
    case 'military':
      return !!p.military;
    case 'medical':
      return !!p.medical;
    case 'emergencies':
      return !!p.emergency;
  }
}

export function matches(p: Plane, f: ListFilter): boolean {
  // Ground traffic is clutter in general, but a BGSU plane taxiing at its home field is the point.
  const ground = f.onGround ?? (f.fleet ? 'show' : 'hide');
  if (ground === 'hide' && p.onGround) return false;
  if (ground === 'only' && !p.onGround) return false;
  if (f.fleet === 'bgsu' && p.tag !== BGSU_TAG) return false;
  if (f.kind && !matchesKind(p, f.kind)) return false;
  if (f.airline && !new RegExp(`^${f.airline}\\d`).test(p.callsign?.toUpperCase() ?? '')) return false;
  if (f.typeCode && p.typeCode?.toUpperCase() !== f.typeCode) return false;
  if (f.minAltFt != null && !(p.altitudeFt != null && p.altitudeFt >= f.minAltFt)) return false;
  if (f.maxAltFt != null && !(p.altitudeFt != null && p.altitudeFt <= f.maxAltFt)) return false;
  if (f.minDistNm != null && p.distanceKm < f.minDistNm * KM_PER_NM) return false;
  if (f.maxDistNm != null && p.distanceKm > f.maxDistNm * KM_PER_NM) return false;
  if (f.climbing || f.descending) {
    const rate = p.onGround ? 0 : (p.verticalRateFpm ?? 0);
    const ok = (f.climbing && rate >= LEVEL_FPM) || (f.descending && rate <= -LEVEL_FPM);
    if (!ok) return false;
  }
  if (f.query) {
    const hay = `${p.callsign ?? ''} ${p.registration ?? ''} ${p.id}`.toUpperCase().replace(/-/g, '');
    if (!hay.includes(f.query.replace(/-/g, ''))) return false;
  }
  return true;
}

const SORT_VALUE: Record<SortKey, (p: Plane) => number | null> = {
  distance: (p) => p.distanceKm,
  altitude: (p) => p.altitudeFt,
  speed: (p) => p.groundSpeedKt,
};
/** Nearest first, but highest and fastest first. */
const DEFAULT_ORDER: Record<SortKey, SortOrder> = { distance: 'asc', altitude: 'desc', speed: 'desc' };

/** Matching planes in list order (not paged). Planes missing the sort value go last. */
export function applyFilter(planes: Plane[], f: ListFilter): Plane[] {
  const key = f.sort ?? 'distance';
  const sign = (f.order ?? DEFAULT_ORDER[key]) === 'asc' ? 1 : -1;
  const value = SORT_VALUE[key];
  return planes
    .filter((p) => matches(p, f))
    .sort((a, b) => {
      const [va, vb] = [value(a), value(b)];
      if (va == null || vb == null) return va == null ? (vb == null ? 0 : 1) : -1;
      return (va - vb) * sign || a.distanceKm - b.distanceKm;
    });
}

export const pageCount = (matched: number) => Math.max(1, Math.ceil(matched / PAGE_SIZE));

const KIND_CHIPS: Record<ListKind, string> = {
  jets: '✈ jets',
  props: '✈ props',
  helicopters: '🚁 helicopters',
  military: 'military',
  medical: 'medical',
  emergencies: 'emergencies',
};
const feet = (ft: number) => `${Math.round(ft).toLocaleString('en-US')} ft`;

/** The active filters as short labels for the list header, e.g. ["✈ jets", ">30,000 ft", "SWA"]. */
export function filterChips(f: ListFilter): string[] {
  const chips: string[] = [];
  if (f.fleet === 'bgsu') chips.push(BGSU_TAG);
  if (f.kind) chips.push(KIND_CHIPS[f.kind]);
  if (f.airline) chips.push(f.airline);
  if (f.typeCode) chips.push(f.typeCode);
  if (f.minAltFt != null) chips.push(`>${feet(f.minAltFt)}`);
  if (f.maxAltFt != null) chips.push(`<${feet(f.maxAltFt)}`);
  if (f.minDistNm != null) chips.push(`>${Math.round(f.minDistNm)} nm`);
  if (f.maxDistNm != null) chips.push(`<${Math.round(f.maxDistNm)} nm`);
  if (f.climbing) chips.push('↑ climbing');
  if (f.descending) chips.push('↓ descending');
  if (f.onGround === 'show') chips.push('+ ground');
  if (f.onGround === 'only') chips.push('on ground');
  if (f.query) chips.push(`“${f.query}”`);
  if (f.sort && (f.sort !== 'distance' || f.order === 'desc')) {
    chips.push(`${(f.order ?? DEFAULT_ORDER[f.sort]) === 'asc' ? '↑' : '↓'} ${f.sort}`);
  }
  return chips;
}

/** Filters the dev-mode F key steps through (after "no filter"). */
export const DEV_PRESETS: ListFilter[] = [
  { fleet: 'bgsu' },
  { kind: 'jets', minAltFt: 30_000 },
  { kind: 'props' },
  { kind: 'helicopters' },
  { airline: 'SWA' },
  { kind: 'military' },
  { descending: true, maxAltFt: 10_000 },
  { sort: 'altitude' },
  { sort: 'speed' },
  { onGround: 'only' },
  { maxDistNm: 30 },
];
