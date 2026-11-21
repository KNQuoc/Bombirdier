// A filter on the sky itself: "only show helicopters in the sky". The list has its own filter; this
// one decides which planes get an icon on the compass bar, a bracket in the sky and a dot on the
// radar. It is not saved: a forgotten filter that quietly hides planes would look like missing
// data, so it is gone after a restart, and while it is on the HUD says so.

import type { Plane } from '@web/planes';
import { filterChips, matches, sanitizeFilter } from './list/filter';
import type { ListFilter } from './list/filter';

/** The part of a list filter that makes sense for the sky: what to show, not how to sort or page it. */
export function skyFilterFrom(input: unknown): ListFilter | null {
  const { sort: _sort, order: _order, page: _page, ...what } = sanitizeFilter(input);
  return Object.keys(what).length ? what : null;
}

/**
 * The planes a sky filter lets through. Planes on the ground stay in unless the filter itself says
 * otherwise (the list hides them by default; the sky never did).
 */
export function applySkyFilter(planes: Plane[], filter: ListFilter | null): Plane[] {
  if (!filter) return planes;
  const f: ListFilter = { onGround: 'show', ...filter };
  return planes.filter((p) => matches(p, f));
}

/** "helicopters", "BGSU, <3,000 ft": what the filter keeps, for the HUD and for speech. */
export function skyFilterLabel(filter: ListFilter): string {
  return filterChips(filter).map((c) => c.replace(/^[^\p{L}\p{N}<>“]+\s*/u, '')).join(', ');
}
