// Carries out what the assistant asked for (list, radar, runway, radio) and, where only the phone knows
// the answer, words the reply: the Mac never sees all 250 nm of traffic, so "how many helicopters?"
// is counted here.

import type { Plane } from '@web/planes';
import { KM_PER_NM } from '../flights/nearby';
import { sanitizeFilter } from '../list/filter';
import type { ListFilter } from '../list/filter';
import { compassWord, rowName } from '../list/list';
import type { PlaneList } from '../list/list';
import type { VoiceAction } from './server';

export type ActionDeps = {
  list: PlaneList;
  /** null = back to automatic. */
  setRadarRangeKm: (km: number | null) => void;
  setRunway: (ident: string) => boolean;
  /** How far out the compass bar and the sky show planes. null = the default. */
  setArRadiusKm: (km: number | null) => void;
  /**
   * Only show matching planes in the sky. 'list' = the list's current filter; null = everything.
   * Returns what is now in force: the filter's label (null = none), how many planes it lets
   * through, and the AR radius they are within.
   */
  setSkyFilter: (filter: unknown | 'list' | null) => { label: string | null; matching: number; withinKm: number };
  /** Planes coloured by controller, on or off. */
  setAirspace: (on: boolean) => void;
  /** The airspace view's legend box, on or off (on also turns the view on). */
  setLegend: (on: boolean) => void;
  /** How far the data reaches, for "no helicopters within 250 miles". */
  coverageNm: () => number;
  /** How many planes the app knows about at all. Zero means there's no data, not an empty sky. */
  knownPlanes: () => number;
  /** The radio you can listen to (Phase 5). */
  radio: {
    /**
     * Starts listening to a feed. `scope` "facility" = every channel of its controller in the
     * transcript, "channel" = only this one. Returns what to say if that isn't possible, else null.
     */
    connect: (feedId: string, scope?: string) => string | null;
    /** all | one: the controller's whole transcript, or only the channel that is playing. False when not connected. */
    scope: (state: string) => boolean;
    disconnect: () => void;
    /** on | off | up | down. False when not connected. */
    audio: (state: string) => boolean;
    /** show | hide. False when not connected. */
    transcript: (state: string) => boolean;
  };
};

const NOT_CONNECTED = "You're not connected to a frequency.";

const KIND_NOUNS: Record<string, [string, string]> = {
  jets: ['jet', 'jets'],
  props: ['propeller plane', 'propeller planes'],
  helicopters: ['helicopter', 'helicopters'],
  military: ['military aircraft', 'military aircraft'],
  medical: ['medical flight', 'medical flights'],
  emergencies: ['emergency', 'emergencies'],
};

/** Distance for speech, in nautical miles: "miles" is what pilots say (the HUD itself shows km). */
export function spokenMiles(distanceKm: number): string {
  const nm = distanceKm / KM_PER_NM;
  if (nm < 1) return 'less than a mile';
  if (nm < 10) {
    const text = nm.toFixed(1).replace(/\.0$/, '');
    return text === '1' ? '1 mile' : `${text} miles`;
  }
  return `${Math.round(nm)} miles`;
}

/** "12 helicopters", "1 BGSU plane", "172 jets match": what a filter's results are called. */
function counted(n: number, f: ListFilter): string {
  const [one, many] = f.fleet === 'bgsu' ? ['BGSU plane', 'BGSU planes'] : f.kind ? KIND_NOUNS[f.kind] : ['plane', 'planes'];
  // Anything beyond the noun itself (altitude, airline, distance...) makes it a "match".
  const { fleet: _fleet, kind: _kind, sort: _sort, order: _order, page: _page, ...rest } = f;
  const narrowed = Object.keys(rest).length > 0;
  return `${n} ${n === 1 ? one : many}${narrowed ? (n === 1 ? ' matches' : ' match') : ''}`;
}

const NO_DATA = "I don't have any traffic data right now.";

function nothing(f: ListFilter, coverageNm: number): string {
  const many = f.fleet === 'bgsu' ? 'BGSU planes' : f.kind ? KIND_NOUNS[f.kind][1] : 'planes';
  const { fleet: _fleet, kind: _kind, sort: _sort, order: _order, page: _page, ...rest } = f;
  return Object.keys(rest).length ? `No ${many} match right now.` : `No ${many} within ${coverageNm} miles right now.`;
}

/** "12 helicopters, closest is 18 miles north." from what the list now holds. */
function listSummary(deps: ActionDeps): string | null {
  const view = deps.list.view();
  if (!view) return null;
  const filter = deps.list.state().filter;
  if (!deps.knownPlanes()) return NO_DATA;
  if (!view.matched.length) return nothing(filter, deps.coverageNm());
  const nearest = view.matched.reduce((a, b) => (b.distanceKm < a.distanceKm ? b : a));
  return `${counted(view.matched.length, filter)}, closest is ${spokenMiles(nearest.distanceKm)} ${compassWord(nearest.bearingDeg)}.`;
}

function openedSummary(plane: Plane, belowHorizon: boolean): string {
  const kind = plane.typeName ?? plane.typeCode ?? (plane.kind === 'helicopter' ? 'helicopter' : null);
  const where = `${spokenMiles(plane.distanceKm)} ${compassWord(plane.bearingDeg)}${belowHorizon ? ', below the horizon' : ''}`;
  return `${rowName(plane).split('').join(' ')}${kind ? `, ${kind}` : ''}. It's ${where}.`;
}

/**
 * Applies the actions in order. Returns what to say instead of the server's answer when the phone
 * knows better (counts, what got opened), or null to say the server's answer as it is.
 */
export function applyActions(actions: VoiceAction[], deps: ActionDeps): string | null {
  const { list } = deps;
  let say: string | null = null;
  for (const a of actions) {
    switch (a.type) {
      case 'show_list':
        list.show(a.filter === undefined ? undefined : a.filter);
        say = listSummary(deps);
        break;
      case 'hide_list':
        list.hide();
        break;
      case 'set_filter':
        if (!list.isOpen()) list.show();
        list.setFilter(a.filter);
        say = listSummary(deps);
        break;
      case 'clear_filter':
        list.clearFilter();
        if (list.isOpen()) say = listSummary(deps);
        break;
      case 'sort':
        if (a.by === 'distance' || a.by === 'altitude' || a.by === 'speed') {
          if (!list.isOpen()) list.show();
          list.sort(a.by, a.order === 'asc' || a.order === 'desc' ? a.order : undefined);
        }
        break;
      case 'page': {
        if (!list.isOpen()) list.show();
        list.page(a.direction === 'prev' ? 'prev' : 'next');
        const view = list.view();
        if (view) say = `Page ${view.page + 1} of ${view.pages}.`;
        break;
      }
      case 'open_row': {
        const row = list.view()?.rows.find((r) => r.n === a.n);
        if (row && list.openRow(row.n)) say = openedSummary(row.plane, row.belowHorizon);
        else say = list.isOpen() ? `There's no row ${a.n} on this page.` : 'The list is closed. Ask me to show the list first.';
        break;
      }
      case 'open_plane': {
        const plane = a.query ? list.openPlane(a.query) : null;
        const opened = list.view()?.opened;
        say = plane && opened ? openedSummary(opened.plane, /below horizon/.test(opened.lines.join(' '))) : "I can't find that one in the traffic I have.";
        break;
      }
      case 'close_plane':
        list.closePlane();
        break;
      case 'count': {
        const filter = sanitizeFilter(a.filter);
        if (list.count(filter) > 0) {
          // "Any emergencies?" with a yes: show them.
          list.show(filter);
          say = listSummary(deps);
        } else {
          say = deps.knownPlanes() ? nothing(filter, deps.coverageNm()) : NO_DATA;
        }
        break;
      }
      case 'radar_range':
        deps.setRadarRangeKm(a.nm && a.nm > 0 ? a.nm * KM_PER_NM : null);
        break;
      case 'set_runway':
        if (a.runway && !deps.setRunway(a.runway)) say = `There's no runway ${a.runway} here.`;
        break;
      case 'sky_filter': {
        const now = deps.setSkyFilter(a.fromList ? 'list' : (a.filter ?? null));
        if (!now.label) say = a.fromList ? 'The list has no filter to use, so the sky shows everything.' : 'Showing everything in the sky again.';
        else if (!now.matching) say = `Only ${now.label} in the sky now. None within ${Math.round(now.withinKm)} kilometers right now.`;
        else say = `Only ${now.label} in the sky now: ${now.matching} within ${Math.round(now.withinKm)} kilometers.`;
        break;
      }
      case 'airspace':
        if (a.state === 'show' || a.state === 'hide') deps.setAirspace(a.state === 'show');
        break;
      case 'legend':
        if (a.state === 'show' || a.state === 'hide') deps.setLegend(a.state === 'show');
        break;
      case 'ar_range':
        if (typeof a.km === 'number' && a.km >= 0) deps.setArRadiusKm(a.km > 0 ? a.km : null);
        break;
      case 'connect_feed': {
        const problem = a.feed ? deps.radio.connect(a.feed, a.scope) : "I don't know which frequency you mean.";
        if (problem) say = problem;
        break;
      }
      case 'radio_scope':
        if (!a.state || !deps.radio.scope(a.state)) say = NOT_CONNECTED;
        break;
      case 'disconnect_feed':
        deps.radio.disconnect();
        break;
      case 'radio_audio':
        if (!a.state || !deps.radio.audio(a.state)) say = NOT_CONNECTED;
        break;
      case 'transcript':
        if (!a.state || !deps.radio.transcript(a.state)) say = NOT_CONNECTED;
        break;
      default:
        // An action this build doesn't know (a newer server): skip it.
        break;
    }
  }
  return say;
}
