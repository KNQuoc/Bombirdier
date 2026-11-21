// Per-frame HUD drawn on a canvas. The same draw call runs once per eye so both eyes
// always show identical content (required for the two images to fuse in the headset).
//
// Everything hangs off one "headband" compass bar near the top of the view:
//   on the bar:    a plane or helicopter icon per aircraft at its bearing, center mark
//   below the bar: degree ticks/labels, current heading
//   right under that: info card for the focused plane, attached to the compass
//                  (drops down like a notification)
//   in the sky:    when the caller passes pitchDeg + viewerAltM, a bracket on each plane at its
//                  real position (direction AND altitude), and the focused plane's card hangs
//                  under its bracket instead of under the compass. Without them: compass only.
// Voice ("hey grok") status and answers show as subtitles near the bottom.
// A heading-up radar mini-map sits in the lower left (hidden while a voice answer is showing).
// Optional extras for callers (all off by default): radarPlanes / radarRangeKm, highlightIds, guideId,
// showCard, and airport (runways + traffic pattern on the radar and in the sky, leg codes by the dots). COLORS, fs, label and roundRect are exported so a caller can draw its own panel in the
// same style on the same canvas after drawHud().
// The middle of the view stays clear.

import { aircraftStatus, cardLines, cardTag, flightLabel } from './format';
import type { AircraftStatus } from './format';
import { elevationDeg, halfFovDeg, normalizeDeg, projectSky, projectX, signedDiffDeg } from './geo';
import type { SkyPoint } from './geo';
import type { Plane } from './planes';
import type { VoiceState } from './voice';

/** What the voice subtitles show. Timing (when to clear the answer) is handled by main.ts. */
export type VoiceHud = {
  state: VoiceState;
  transcript: string | null;
  answer: string | null;
  error: string | null;
  /** The assistant's name on the "speaking" pill. Default "Grok". */
  name?: string;
  /** Idle hint shown for the first seconds. Default: Say "Hey Grok…". */
  hint?: string;
};

/** Planes the viewer is looking at this frame (offsetDeg filled in), for voice context. */
export type HudResult = {
  focus: Plane | null;
  inView: Plane[];
  /** The station in the middle of the view, when it (and not a plane) has the focus. */
  station?: HudStation | null;
};

/**
 * Something on the ground that gets an icon on the compass bar at its bearing and a card when you
 * look at it: an air traffic controller's site, say. It has no place in the sky, so it counts as
 * sitting on the horizon.
 */
export type HudStation = {
  id: string;
  bearingDeg: number;
  /** Status dot beside the icon, and the card's accent. */
  color: string;
  /** Card lines, title first. */
  card: string[];
  tag?: string | null;
};

const NO_PLANES: HudResult = { focus: null, inView: [] };

export type HudState = {
  headingDeg: number | null;
  /** tan(half horizontal FOV) of what one eye shows. */
  halfTan: number;
  planes: Plane[];
  /** Data feed status, shown when there are no planes at all (e.g. "live · waiting for GPS"). */
  status: string;
  /** Frame timestamp (same for both eyes) for animations. */
  timeMs: number;
  /** null = voice disabled. */
  voice: VoiceHud | null;
  /**
   * Camera pitch, degrees above the horizon. Together with viewerAltM this turns on sky markers
   * (planes placed at their real altitude). Missing/null = compass bar only, as before.
   */
  pitchDeg?: number | null;
  /** Viewer's eye altitude in meters, same reference as Plane.altitudeGeomFt (WGS84 ellipsoid). */
  viewerAltM?: number | null;
  /** Radar: draw these planes instead of `planes` (e.g. a filtered list reaching far past the AR view). */
  radarPlanes?: Plane[];
  /** Radar: fixed range in km instead of fitting the farthest plane. Missing/null = auto. */
  radarRangeKm?: number | null;
  /** Planes to call attention to: a pulsing ring on the sky bracket, the compass icon and the radar dot. */
  highlightIds?: string[];
  /** The compass shows an arrow toward this plane whenever it is off the bar. */
  guideId?: string | null;
  /** false = no info card for the focused plane (something else is using that space). Default: shown. */
  showCard?: boolean;
  /** A nearby airport to draw: runways and traffic pattern on the radar, the pattern in the sky. */
  airport?: AirportOverlay | null;
  /** Ground stations on the compass bar (see HudStation). */
  stations?: HudStation[];
  /** Leave the radar out this frame (something else is using the bottom of the view). */
  hideRadar?: boolean;
  /** What to write under the compass when `planes` is empty, instead of "No planes · <status>". */
  emptyText?: string;
};

/** A point as seen from where you stand. */
export type RadarPoint = { bearingDeg: number; distanceKm: number };

export type AirportOverlay = {
  /** Each runway's two ends: drawn on the radar as a thick line. */
  runways: [RadarPoint, RadarPoint][];
  /** The traffic pattern in the order it's flown: drawn on the radar as a dashed line. */
  pattern: RadarPoint[];
  /** Short leg code per plane id ("DW", "B", "F"...), drawn next to that plane's radar dot. */
  legCodes?: Record<string, string>;
  /**
   * The same pattern with altitudes (meters, same reference as viewerAltM), sampled closely: drawn
   * as a faint dashed line in the sky when sky markers are on.
   */
  skyPattern?: (RadarPoint & { altM: number })[];
};

const M_PER_FT = 0.3048;
/** Ground traffic sits about this far below your eyes: right at the horizon. */
const GROUND_TRAFFIC_BELOW_EYE_M = 1.7;
/** Sky markers are only drawn inside this vertical band (fractions of eye height): the lenses hide the rest. */
const SKY_TOP = 0.06;
const SKY_BOTTOM = 0.94;
/** The card follows the focused plane's bracket only while the bracket is above this (fraction of eye height). */
const SKY_CARD_MAX_Y = 0.58;

export const COLORS = {
  hud: 'rgba(79, 195, 247, 0.95)',
  hudDim: 'rgba(79, 195, 247, 0.55)',
  focus: '#ffc94d',
  text: '#ffffff',
  panel: 'rgba(0, 0, 0, 0.62)',
  shadow: 'rgba(0, 0, 0, 0.8)',
};

/** Icon/accent color per aircraft status (normal planes use the HUD blue, focus adds yellow). */
export const STATUS_COLORS: Record<AircraftStatus, string> = {
  emergency: '#ff3b30',
  ground: '#9e9e9e',
  medical: '#c77dff',
  military: '#4cd964',
  normal: COLORS.hud,
};
/** A plane's color: by status, or its own accent (Plane.accent) if it has no special status. */
export const planeColor = (p: Plane, status: AircraftStatus = aircraftStatus(p)) =>
  status === 'normal' && p.accent ? p.accent : STATUS_COLORS[status];
/** Emergency blink: on/off period in ms. */
const BLINK_MS = 400;

export const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/** Global text size multiplier; tune here if text is too big/small in the headset. */
const TEXT_SCALE = 0.8;
export const fs = (px: number) => Math.round(px * TEXT_SCALE * 10) / 10;

/** Vertical position of the compass bar (fraction of eye height). The lenses hide the very top. */
const COMPASS_Y = 0.24;
/** Compass bar spans this fraction of the eye width, centered (the lenses hide the edges). */
const COMPASS_WIDTH = 0.7;
/** A plane gets the info card only when it's within this angle of center (15° total cone). */
export const FOCUS_HALF_DEG = 7.5;
/** Card pop-up animation length. */
const CARD_ANIM_MS = 180;

// Tracks when the current focus plane became focused, for the pop-up animation.
let focusAnim: { id: string; since: number } | null = null;

/** Subtitle area for voice: bottom edge of the answer panel (fraction of eye height). */
const VOICE_Y = 0.84;
/** How long the idle "Say Hey Grok" hint stays after start (ms). */
const HINT_MS = 15000;

export function drawHud(ctx: CanvasRenderingContext2D, w: number, h: number, s: HudState): HudResult {
  ctx.clearRect(0, 0, w, h);
  ctx.textBaseline = 'middle';
  if (s.airport?.skyPattern) drawSkyPattern(ctx, w, h, s, s.airport.skyPattern);
  const result = drawPlanes(ctx, w, h, s);
  // The radar steps aside while a voice question/answer is on screen (they share the bottom of the view).
  const voiceShowing = !!(s.voice?.answer || s.voice?.transcript);
  const radarPlanes = s.radarPlanes ?? s.planes;
  if (s.headingDeg != null && (radarPlanes.length || s.airport) && !voiceShowing && !s.hideRadar) {
    drawRadar(ctx, w, h, s, radarPlanes, s.headingDeg, result.focus?.id ?? null);
  }
  if (s.voice) drawVoice(ctx, w, h, s.voice, s.timeMs);
  return result;
}

/** Radar center (fractions of eye width/height) and radius (fraction of eye width). Kept inward: lens edges blur. */
const RADAR_X = 0.26;
const RADAR_Y = 0.7;
const RADAR_R = 0.1;
/** Radar range snaps to the smallest of these that fits the farthest plane (km). 463 km = 250 nm. */
const RADAR_RANGES_KM = [5, 10, 15, 20, 30, 40, 60, 80, 120, 160, 240, 320, 463];
/** With more dots than this on the radar, they're drawn smaller so the disc doesn't fill in. */
const RADAR_CROWDED = 150;

/**
 * Heading-up radar: you're at the center, your view cone points up, planes are dots at their true
 * direction and distance (colored by status, focused plane yellow), and N/E/S/W orbit the rim.
 */
function drawRadar(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  s: HudState,
  planes: Plane[],
  heading: number,
  focusId: string | null,
) {
  const cx = w * RADAR_X;
  const cy = h * RADAR_Y;
  const r = w * RADAR_R;
  const farthest = planes.reduce((max, p) => Math.max(max, p.distanceKm), 0);
  const fitted = RADAR_RANGES_KM.find((km) => km >= farthest) ?? RADAR_RANGES_KM[RADAR_RANGES_KM.length - 1];
  const range = s.radarRangeKm != null && s.radarRangeKm > 0 ? s.radarRangeKm : fitted;
  // Screen angle for a bearing: straight up = where you're looking.
  const toXY = (bearingDeg: number, frac: number) => {
    const a = (signedDiffDeg(bearingDeg, heading) * Math.PI) / 180;
    return [cx + Math.sin(a) * r * frac, cy - Math.cos(a) * r * frac] as const;
  };

  ctx.save();
  // Disc + range ring.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = COLORS.hudDim;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, r / 2, 0, Math.PI * 2);
  ctx.stroke();

  // View cone (what's on the compass bar) and the focus cone inside it.
  const wedge = (halfDeg: number, fill: string) => {
    const a = (halfDeg * Math.PI) / 180;
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, -Math.PI / 2 - a, -Math.PI / 2 + a);
    ctx.closePath();
    ctx.fill();
  };
  wedge(halfFovDeg(s.halfTan), 'rgba(79, 195, 247, 0.18)');
  wedge(FOCUS_HALF_DEG, 'rgba(255, 201, 77, 0.22)');

  if (s.airport) drawRadarAirport(ctx, cx, cy, r, range, toXY, s.airport);

  // Compass: tick marks every 30° around the rim, and N/E/S/W just outside it (N highlighted).
  ctx.strokeStyle = COLORS.hudDim;
  ctx.lineWidth = 1;
  for (let deg = 0; deg < 360; deg += 30) {
    const [x1, y1] = toXY(deg, deg % 90 === 0 ? 0.86 : 0.92);
    const [x2, y2] = toXY(deg, 1);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  const labelFrac = 1 + fs(8) / r;
  for (const [deg, name] of [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W']] as const) {
    const [x, y] = toXY(deg, labelFrac);
    label(ctx, x, y, name, fs(deg === 0 ? 11 : 9), deg === 0 ? COLORS.focus : COLORS.text, 'center', true);
  }

  // Planes, far to near so close ones draw on top; the focused one last.
  const blinkOff = Math.floor(s.timeMs / BLINK_MS) % 2 === 1;
  const inRange = planes.filter((p) => p.distanceKm <= range).sort((a, b) => b.distanceKm - a.distanceKm);
  const marked = new Set(s.highlightIds ?? []);
  if (focusId) marked.add(focusId);
  const dot = inRange.length > RADAR_CROWDED ? 1.5 : 2.2;
  for (const p of [...inRange.filter((p) => !marked.has(p.id)), ...inRange.filter((p) => marked.has(p.id))]) {
    const status = aircraftStatus(p);
    if (status === 'emergency' && blinkOff) continue;
    const [x, y] = toXY(p.bearingDeg, p.distanceKm / range);
    ctx.fillStyle = marked.has(p.id) ? COLORS.focus : planeColor(p, status);
    ctx.beginPath();
    ctx.arc(x, y, marked.has(p.id) ? 3.2 : dot, 0, Math.PI * 2);
    ctx.fill();
    if (s.highlightIds?.includes(p.id)) drawPulse(ctx, x, y, 4, s.timeMs);
    const code = s.airport?.legCodes?.[p.id];
    if (code) label(ctx, x + 4, y - 4, code, fs(7.5), COLORS.text, 'left', true);
  }
  // Planes past a fixed range: faint dots on the rim, so you know which way the rest of the traffic is.
  if (s.radarRangeKm != null) {
    ctx.fillStyle = 'rgba(79, 195, 247, 0.5)';
    for (const p of planes) {
      if (p.distanceKm <= range) continue;
      const [x, y] = toXY(p.bearingDeg, 1);
      ctx.beginPath();
      ctx.arc(x, y, 1.3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // You.
  ctx.fillStyle = COLORS.text;
  ctx.beginPath();
  ctx.arc(cx, cy, 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Range below the disc, outside the ring of N/E/S/W labels.
  label(ctx, cx, cy + r + fs(20), `${range} km`, fs(8), 'rgba(255,255,255,0.75)', 'center');
}

/** Runways (thick) and the traffic pattern (dashed) on the radar, clipped to the disc. */
function drawRadarAirport(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  range: number,
  toXY: (bearingDeg: number, frac: number) => readonly [number, number],
  airport: AirportOverlay,
) {
  const path = (points: RadarPoint[]) => {
    ctx.beginPath();
    points.forEach((p, i) => {
      const [x, y] = toXY(p.bearingDeg, p.distanceKm / range);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  };
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.lineCap = 'round';
  ctx.strokeStyle = COLORS.hud;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 2.5]);
  path(airport.pattern);
  ctx.setLineDash([]);
  ctx.strokeStyle = COLORS.text;
  ctx.lineWidth = 2.5;
  for (const runway of airport.runways) path(runway);
  ctx.restore();
}

/** The traffic pattern as a faint dashed line where it really is in the sky. Needs sky mode (pitch + altitude). */
function drawSkyPattern(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  s: HudState,
  points: (RadarPoint & { altM: number })[],
) {
  if (s.headingDeg == null || s.pitchDeg == null || s.viewerAltM == null) return;
  const { headingDeg, pitchDeg, viewerAltM, halfTan } = s;
  const projected = points.map((p) =>
    projectSky(p.bearingDeg, elevationDeg(p.altM - viewerAltM, p.distanceKm), headingDeg, pitchDeg, halfTan, w, h),
  );
  // A point just in front of the camera plane projects wildly far away: don't draw lines to those.
  const usable = (pt: SkyPoint | null): pt is SkyPoint => !!pt && Math.abs(pt.x - w / 2) < w * 3 && Math.abs(pt.y - h / 2) < h * 3;
  ctx.save();
  ctx.strokeStyle = 'rgba(79, 195, 247, 0.6)';
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  ctx.setLineDash([6, 6]);
  ctx.shadowColor = COLORS.shadow;
  ctx.shadowBlur = 2;
  ctx.beginPath();
  let drawing = false;
  for (const pt of projected) {
    if (!usable(pt)) {
      drawing = false;
    } else if (drawing) {
      ctx.lineTo(pt.x, pt.y);
    } else {
      ctx.moveTo(pt.x, pt.y);
      drawing = true;
    }
  }
  ctx.stroke();
  ctx.restore();
}

function drawPlanes(ctx: CanvasRenderingContext2D, w: number, h: number, s: HudState): HudResult {
  const barY = h * COMPASS_Y;
  const x0 = (w * (1 - COMPASS_WIDTH)) / 2;
  const x1 = w - x0;

  if (s.headingDeg == null) {
    label(ctx, w / 2, barY, 'Waiting for compass…', fs(14), COLORS.text, 'center', true);
    return NO_PLANES;
  }
  const heading = s.headingDeg;
  drawCompass(ctx, w, barY, x0, x1, heading, s.halfTan);

  // Stations sit on the horizon: looking at one means facing it with the view about level.
  const stations = (s.stations ?? []).map((st) => {
    const off = signedDiffDeg(st.bearingDeg, heading);
    return { st, off, aim: Math.hypot(off, s.pitchDeg ?? 0) };
  });
  const nearestStation = stations.reduce<(typeof stations)[number] | null>((a, b) => (!a || b.aim < a.aim ? b : a), null);
  const stationInFocus = nearestStation && nearestStation.aim <= FOCUS_HALF_DEG ? nearestStation : null;

  const result = drawAircraftLayer(ctx, w, h, s, heading, barY, x0, x1, stationInFocus?.aim ?? null);
  if (!stations.length) return result;

  const focused = result.focus ? null : stationInFocus;
  for (const m of stations) {
    const x = Math.abs(m.off) <= halfFovDeg(s.halfTan) ? projectX(m.off, s.halfTan, w) : null;
    if (x != null && x >= x0 && x <= x1) drawStation(ctx, x, barY, m.st, m === focused);
  }
  if (!focused) {
    stationAnim = null;
    return result;
  }
  if (stationAnim?.id !== focused.st.id) stationAnim = { id: focused.st.id, since: s.timeMs };
  if (s.showCard !== false) {
    const t = Math.min(1, (s.timeMs - stationAnim.since) / CARD_ANIM_MS);
    const x = projectX(focused.off, s.halfTan, w) ?? w / 2;
    const radar = { x: w * RADAR_X, y: h * RADAR_Y, r: w * RADAR_R + fs(14) };
    drawCard(ctx, w, x, labelRowY(barY) + fs(10), focused.st.card, t, focused.st.color, focused.st.tag ?? null, radar);
  }
  return { ...result, station: focused.st };
}

let stationAnim: { id: string; since: number } | null = null;

/** A small radio mast on the compass bar, with a status dot. */
function drawStation(ctx: CanvasRenderingContext2D, x: number, y: number, st: HudStation, focus: boolean) {
  const color = focus ? COLORS.focus : COLORS.text;
  const size = focus ? 9 : 7;
  ctx.save();
  ctx.shadowColor = COLORS.shadow;
  ctx.shadowBlur = 3;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = focus ? 2 : 1.5;
  ctx.lineCap = 'round';
  // Mast: a narrow A-frame with a crossbar.
  ctx.beginPath();
  ctx.moveTo(x - size * 0.55, y + size);
  ctx.lineTo(x, y - size * 0.5);
  ctx.lineTo(x + size * 0.55, y + size);
  ctx.moveTo(x - size * 0.3, y + size * 0.35);
  ctx.lineTo(x + size * 0.3, y + size * 0.35);
  ctx.stroke();
  // Radio waves from the top.
  for (const r of [size * 0.55, size * 0.95]) {
    ctx.beginPath();
    ctx.arc(x, y - size * 0.5, r, -Math.PI * 0.85, -Math.PI * 0.15);
    ctx.stroke();
  }
  // Status dot at the foot.
  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.beginPath();
  ctx.arc(x + size * 0.95, y + size * 0.9, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = st.color;
  ctx.beginPath();
  ctx.arc(x + size * 0.95, y + size * 0.9, 2.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Aircraft on the compass bar and in the sky, and the focused one's card. `stationAim`: how far off center a station in the focus cone is, if one is. */
function drawAircraftLayer(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  s: HudState,
  heading: number,
  barY: number,
  x0: number,
  x1: number,
  stationAim: number | null,
): HudResult {
  const half = halfFovDeg(s.halfTan);
  const withOffset = s.planes.map((p) => ({ p, off: signedDiffDeg(p.bearingDeg, heading) }));
  const onBar = withOffset
    .filter((x) => Math.abs(x.off) <= half)
    .map((x) => ({ ...x, x: projectX(x.off, s.halfTan, w) }))
    .filter((x): x is typeof x & { x: number } => x.x != null && x.x >= x0 && x.x <= x1);

  if (s.planes.length === 0) {
    focusAnim = null;
    // A station's card goes in the same spot: it takes precedence over this note.
    if (stationAim == null) label(ctx, w / 2, labelRowY(barY) + fs(18), s.emptyText ?? `No planes · ${s.status}`, fs(11), COLORS.text, 'center');
    return NO_PLANES;
  }

  // Sky mode: where each plane really is in the camera image (direction + altitude).
  const sky = new Map<string, SkyPoint>();
  if (s.pitchDeg != null && s.viewerAltM != null) {
    for (const p of s.planes) {
      const pt = skyPoint(p, heading, s.pitchDeg, s.viewerAltM, s.halfTan, w, h);
      if (pt) sky.set(p.id, pt);
    }
  }
  // Focus = the plane closest to the view center: by true angle in sky mode, by compass direction
  // otherwise (or for a plane with no altitude).
  const aim = (x: { p: Plane; off: number }) => sky.get(x.p.id)?.offCenterDeg ?? Math.abs(x.off);
  const best = withOffset.reduce<(typeof withOffset)[number] | null>((a, b) => (!a || aim(b) < aim(a) ? b : a), null);
  // A station nearer the center than any plane takes the focus instead.
  const focus = best && aim(best) <= FOCUS_HALF_DEG && (stationAim == null || aim(best) <= stationAim) ? best : null;

  // A plane the caller wants you to find: the compass points at it whenever it's off the bar.
  const guide = s.guideId ? withOffset.find((x) => x.p.id === s.guideId) : undefined;
  const guideOffBar = guide && !onBar.some((m) => m.p.id === guide.p.id) ? guide : undefined;

  if (onBar.length === 0 && !focus) {
    focusAnim = null;
    const nearest = guideOffBar ?? [...withOffset].sort((a, b) => Math.abs(a.off) - Math.abs(b.off))[0];
    if (nearest) drawEdgeArrow(ctx, barY, x0, x1, nearest.p, nearest.off);
    return NO_PLANES;
  }
  if (guideOffBar) drawEdgeArrow(ctx, barY, x0, x1, guideOffBar.p, guideOffBar.off);

  // Far to near, so closer aircraft draw on top.
  const byDistance = [...onBar].sort((a, b) => b.p.distanceKm - a.p.distanceKm);
  for (const m of byDistance) if (m.p.id !== focus?.p.id) drawAircraft(ctx, m.x, barY, m.p, false, s.timeMs);
  const inSky = [...sky.entries()]
    .filter(([, pt]) => pt.x >= x0 && pt.x <= x1 && pt.y >= h * SKY_TOP && pt.y <= h * SKY_BOTTOM)
    // The radar mini-map covers this patch of the view; don't draw markers underneath it.
    .filter(([, pt]) => Math.hypot(pt.x - w * RADAR_X, pt.y - h * RADAR_Y) > w * RADAR_R + fs(20))
    .map(([id, pt]) => ({ p: s.planes.find((p) => p.id === id)!, pt }))
    .sort((a, b) => b.p.distanceKm - a.p.distanceKm);
  for (const m of inSky) if (m.p.id !== focus?.p.id) drawSkyMarker(ctx, m.pt, m.p, false, s.timeMs);
  for (const id of s.highlightIds ?? []) {
    const onBarAt = onBar.find((m) => m.p.id === id);
    if (onBarAt) drawPulse(ctx, onBarAt.x, barY, 10, s.timeMs);
    const inSkyAt = inSky.find((m) => m.p.id === id);
    if (inSkyAt) drawPulse(ctx, inSkyAt.pt.x, inSkyAt.pt.y, 16, s.timeMs);
  }
  const inView = onBar.map((m) => ({ ...m.p, offsetDeg: m.off }));

  if (!focus) {
    focusAnim = null;
    return { focus: null, inView };
  }
  if (focusAnim?.id !== focus.p.id) focusAnim = { id: focus.p.id, since: s.timeMs };
  const t = Math.min(1, (s.timeMs - focusAnim.since) / CARD_ANIM_MS);
  const focusX = projectX(focus.off, s.halfTan, w);
  if (focusX != null && focusX >= x0 && focusX <= x1) drawAircraft(ctx, focusX, barY, focus.p, true, s.timeMs);
  const status = aircraftStatus(focus.p);
  const accent = status === 'normal' ? (focus.p.accent ?? COLORS.focus) : STATUS_COLORS[status];

  // The card hangs under the plane's bracket when there's room, otherwise under the compass.
  const pt = inSky.find((m) => m.p.id === focus.p.id)?.pt;
  let cardX = focusX ?? w / 2;
  let cardTop = labelRowY(barY) + fs(10);
  if (pt) {
    const r = drawSkyMarker(ctx, pt, focus.p, true, s.timeMs);
    if (pt.y <= h * SKY_CARD_MAX_Y) {
      cardX = pt.x;
      cardTop = Math.max(cardTop, pt.y + r + 8);
    }
  }
  if (s.showCard !== false) {
    // A card hanging low under a sky bracket can reach the radar: it moves over rather than cover it.
    const radar = { x: w * RADAR_X, y: h * RADAR_Y, r: w * RADAR_R + fs(14) };
    drawCard(ctx, w, cardX, cardTop, cardLines(focus.p), t, accent, cardTag(focus.p), radar);
  }
  return { focus: { ...focus.p, offsetDeg: focus.off }, inView };
}

/** Attention ring that grows and fades once every 1.2 s, around a marker of radius `r`. */
function drawPulse(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, timeMs: number) {
  const t = (timeMs % 1200) / 1200;
  ctx.save();
  ctx.strokeStyle = COLORS.focus;
  ctx.lineWidth = 2;
  ctx.globalAlpha = 1 - t;
  ctx.shadowColor = COLORS.shadow;
  ctx.shadowBlur = 3;
  ctx.beginPath();
  ctx.arc(x, y, r * (1 + 1.2 * t), 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/** Where plane `p` appears in the camera image, using its altitude; null if unknown or behind you. */
function skyPoint(
  p: Plane,
  heading: number,
  pitch: number,
  viewerAltM: number,
  halfTan: number,
  w: number,
  h: number,
): SkyPoint | null {
  let heightDiffM: number;
  if (p.onGround) {
    heightDiffM = -GROUND_TRAFFIC_BELOW_EYE_M;
  } else {
    // GPS altitude matches the phone's GPS reference; barometric is the fallback (can be ~100 ft off).
    const ft = p.altitudeGeomFt ?? p.altitudeFt;
    if (ft == null) return null;
    heightDiffM = ft * M_PER_FT - viewerAltM;
  }
  return projectSky(p.bearingDeg, elevationDeg(heightDiffM, p.distanceKm), heading, pitch, halfTan, w, h);
}

/**
 * Corner brackets around a plane at its real spot in the sky, sized by distance and colored by
 * status. The focused plane gets a bigger, yellow (or status-colored) bracket; others get a small
 * callsign label underneath. Returns the bracket's half-size in px.
 */
function drawSkyMarker(ctx: CanvasRenderingContext2D, pt: SkyPoint, p: Plane, focus: boolean, timeMs: number): number {
  const status = aircraftStatus(p);
  const blinkOff = status === 'emergency' && Math.floor(timeMs / BLINK_MS) % 2 === 1;
  const far = Math.min(1, p.distanceKm / ICON_FAR_KM);
  const r = focus ? 16 : 11 - 4 * far;
  const arm = r * 0.5;
  const color = focus && status === 'normal' ? COLORS.focus : planeColor(p, status);

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = focus ? 2.5 : 1.5;
  ctx.lineCap = 'round';
  ctx.shadowColor = COLORS.shadow;
  ctx.shadowBlur = 4;
  ctx.globalAlpha = blinkOff ? 0.25 : focus ? 1 : 0.85;
  ctx.beginPath();
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    ctx.moveTo(pt.x + sx * r, pt.y + sy * (r - arm));
    ctx.lineTo(pt.x + sx * r, pt.y + sy * r);
    ctx.lineTo(pt.x + sx * (r - arm), pt.y + sy * r);
  }
  ctx.stroke();
  ctx.restore();
  if (!focus) label(ctx, pt.x, pt.y + r + fs(8), flightLabel(p), fs(9), 'rgba(255,255,255,0.85)', 'center');
  return r;
}

let voiceStartMs: number | null = null;

/** Voice subtitles: status pill, the question, and the answer, stacked up from VOICE_Y. */
function drawVoice(ctx: CanvasRenderingContext2D, w: number, h: number, v: VoiceHud, timeMs: number) {
  voiceStartMs ??= timeMs;
  const maxW = w * 0.78;
  let bottom = h * VOICE_Y;

  if (v.error) {
    label(ctx, w / 2, bottom, v.error, fs(10), '#ff8a80', 'center');
    bottom -= fs(16);
  }

  if (v.answer) {
    ctx.save();
    ctx.font = `500 ${fs(12)}px ${FONT}`;
    const lines = wrapLines(ctx, v.answer, maxW - 16).slice(0, 4);
    const lineH = fs(12) + 4;
    const panelW = Math.min(maxW, Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16);
    const panelH = lines.length * lineH + 10;
    const x = (w - panelW) / 2;
    const y = bottom - panelH;
    ctx.fillStyle = COLORS.panel;
    roundRect(ctx, x, y, panelW, panelH, 6);
    ctx.fill();
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = 'left';
    lines.forEach((l, i) => ctx.fillText(l, x + 8, y + 5 + lineH * (i + 0.5)));
    ctx.restore();
    bottom = y - fs(10);
  }

  if (v.transcript && (v.answer || v.state === 'thinking')) {
    ctx.save();
    ctx.font = `italic 500 ${fs(11)}px ${FONT}`;
    const q = wrapLines(ctx, `“${v.transcript}”`, maxW)[0];
    ctx.restore();
    label(ctx, w / 2, bottom, q, fs(11), 'rgba(255,255,255,0.75)', 'center');
    bottom -= fs(18);
  }

  const pulse = 0.5 + 0.5 * Math.sin(timeMs / 180);
  if (v.state === 'listening') pill(ctx, w / 2, bottom, 'Listening…', `rgba(255, 82, 82, ${0.5 + 0.5 * pulse})`);
  else if (v.state === 'thinking') pill(ctx, w / 2, bottom, `Thinking${'.'.repeat(1 + (Math.floor(timeMs / 300) % 3))}`, COLORS.hud);
  else if (v.state === 'speaking') pill(ctx, w / 2, bottom, v.name ?? 'Grok', COLORS.focus);
  else if (!v.answer && !v.error && timeMs - voiceStartMs < HINT_MS) {
    label(ctx, w / 2, bottom, v.hint ?? 'Say “Hey Grok…”', fs(10), 'rgba(255,255,255,0.6)', 'center');
  }
}

/** Small rounded status label with a colored dot. */
function pill(ctx: CanvasRenderingContext2D, cx: number, cy: number, text: string, dot: string) {
  ctx.save();
  ctx.font = `700 ${fs(11)}px ${FONT}`;
  const tw = ctx.measureText(text).width;
  const pw = tw + 26;
  const ph = fs(11) + 8;
  ctx.fillStyle = COLORS.panel;
  roundRect(ctx, cx - pw / 2, cy - ph / 2, pw, ph, ph / 2);
  ctx.fill();
  ctx.fillStyle = dot;
  ctx.beginPath();
  ctx.arc(cx - pw / 2 + 10, cy, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = 'left';
  ctx.fillText(text, cx - pw / 2 + 18, cy);
  ctx.restore();
}

/** Greedy word wrap using the context's current font. */
function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxW) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawCompass(
  ctx: CanvasRenderingContext2D,
  w: number,
  barY: number,
  x0: number,
  x1: number,
  heading: number,
  halfTan: number,
) {
  const half = halfFovDeg(halfTan);
  const labelY = labelRowY(barY);
  const headingBoxHalfW = fs(22);

  ctx.save();
  ctx.strokeStyle = COLORS.hudDim;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x0, barY);
  ctx.lineTo(x1, barY);
  ctx.stroke();

  // Ticks hang below the bar; labels below the ticks.
  const start = Math.ceil((heading - half) / 5) * 5;
  for (let d = start; d <= heading + half; d += 5) {
    const x = projectX(signedDiffDeg(d, heading), halfTan, w);
    if (x == null || x < x0 || x > x1) continue;
    const deg = normalizeDeg(d);
    const major = deg % 30 === 0;
    ctx.strokeStyle = major ? COLORS.hud : COLORS.hudDim;
    ctx.lineWidth = major ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(x, barY);
    ctx.lineTo(x, barY + (major ? 6 : deg % 10 === 0 ? 4 : 2));
    ctx.stroke();
    // Skip labels that would collide with the heading readout in the middle.
    if (major && Math.abs(x - w / 2) > headingBoxHalfW + fs(8)) {
      const name = ({ 0: 'N', 90: 'E', 180: 'S', 270: 'W' } as Record<number, string>)[deg] ?? String(deg);
      label(ctx, x, labelY, name, fs(name.length === 1 ? 12 : 10), COLORS.text, 'center', true);
    }
  }

  // Center mark across the bar + heading readout below it.
  ctx.strokeStyle = COLORS.focus;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(w / 2, barY - 5);
  ctx.lineTo(w / 2, barY + 7);
  ctx.stroke();
  label(ctx, w / 2, labelY, `${Math.round(normalizeDeg(heading))}°`, fs(12), COLORS.focus, 'center', true);
  ctx.restore();
}

// Icons in a 24x24 box centered on (12, 12).
// Plane: top-down silhouette pointing up (Material "flight" icon).
const PLANE_PATH = new Path2D(
  'M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z',
);
// Helicopter: side view facing right (rotor, cabin, tail boom and fin, skids).
const HELI_PATH = (() => {
  const p = new Path2D();
  p.ellipse(14.5, 12.5, 5, 3.6, 0, 0, Math.PI * 2); // cabin
  p.rect(2.5, 11.2, 9, 1.8); // tail boom
  p.rect(1.5, 8.2, 2, 5.5); // tail fin / rotor
  p.rect(13.7, 6.8, 1.6, 2.6); // mast
  p.rect(4, 5.6, 19, 1.5); // main rotor
  p.rect(11.2, 15.5, 1.2, 3); // skid struts
  p.rect(16.8, 15.5, 1.2, 3);
  p.rect(9, 18, 11.5, 1.4); // skid
  return p;
})();

/**
 * Aircraft marker on the compass bar. Oriented by its direction of travel relative to your line
 * of sight: the plane icon points up when flying away, sideways when crossing your view, down when
 * coming toward you; the helicopter faces left or right. Colored by status (see STATUS_COLORS);
 * the focused aircraft is larger, and yellow if it has no special status (otherwise yellow outline).
 */
/** Icon size shrinks with distance (depth cue, less clutter): 15px up close down to 10px at 40 km. */
const ICON_NEAR_PX = 15;
const ICON_FAR_PX = 10;
const ICON_FAR_KM = 40;

function drawAircraft(ctx: CanvasRenderingContext2D, x: number, y: number, p: Plane, focus: boolean, timeMs: number) {
  const status = aircraftStatus(p);
  // Emergencies blink so they're impossible to miss.
  const blinkOff = status === 'emergency' && Math.floor(timeMs / BLINK_MS) % 2 === 1;
  const far = Math.min(1, p.distanceKm / ICON_FAR_KM);
  const size = focus ? 19 : ICON_NEAR_PX - (ICON_NEAR_PX - ICON_FAR_PX) * far;
  const heli = p.kind === 'helicopter';
  // 0 = flying directly away from the viewer, + = moving to the viewer's right.
  const rel = p.trackDeg == null ? 0 : signedDiffDeg(p.trackDeg, p.bearingDeg);
  const s = size / 24;

  ctx.save();
  ctx.translate(x, y);
  if (heli) {
    ctx.scale(rel < 0 ? -s : s, s);
  } else {
    ctx.rotate((rel * Math.PI) / 180);
    ctx.scale(s, s);
  }
  ctx.translate(-12, -12);
  ctx.shadowColor = COLORS.shadow;
  ctx.shadowBlur = 4;
  ctx.lineJoin = 'round';
  if (blinkOff) ctx.globalAlpha = 0.25;
  const path = heli ? HELI_PATH : PLANE_PATH;
  // Outline: yellow marks the focused aircraft when its fill is a status color.
  const focusOutline = focus && status !== 'normal';
  ctx.lineWidth = (focusOutline ? 3.2 : 2.2) / s;
  ctx.strokeStyle = focusOutline ? COLORS.focus : 'rgba(0, 0, 0, 0.7)';
  ctx.stroke(path);
  ctx.fillStyle = focus && status === 'normal' ? COLORS.focus : planeColor(p, status);
  ctx.fill(path);
  ctx.restore();
}

/** Row below the bar holding the degree labels and heading readout. */
const labelRowY = (barY: number) => barY + fs(18);

/**
 * Info card with its top edge at `topY` (under the compass, or under the plane's sky bracket),
 * dropping down into place; the notch points up at x = `mx`. `t` is animation progress 0..1.
 * `accent` colors the side bar and notch; `tag` (e.g. "MEDICAL") is an optional line above the title.
 */
function drawCard(
  ctx: CanvasRenderingContext2D,
  w: number,
  mx: number,
  topY: number,
  lines: string[],
  t: number,
  accent: string,
  tag: string | null,
  /** A circle the card must not cover (the radar): the card slides right of it if they'd overlap. */
  avoid?: { x: number; y: number; r: number },
) {
  const pad = 6;
  const titleSize = fs(15);
  const bodySize = fs(13);
  const tagSize = fs(10);
  const lineGap = 3;
  const tagH = tag ? tagSize + lineGap : 0;
  const ease = 1 - (1 - t) * (1 - t);

  ctx.save();
  ctx.globalAlpha = ease;
  const widths = lines.map((l, i) => {
    ctx.font = `${i === 0 ? 700 : 500} ${i === 0 ? titleSize : bodySize}px ${FONT}`;
    return ctx.measureText(l).width;
  });
  if (tag) {
    ctx.font = `800 ${tagSize}px ${FONT}`;
    widths.push(ctx.measureText(tag).width);
  }
  const cardW = Math.min(w - 12, Math.max(...widths) + pad * 2 + 4);
  const cardH = pad * 2 + tagH + titleSize + (lines.length - 1) * (bodySize + lineGap);
  let x = Math.max(6, Math.min(w - cardW - 6, mx - cardW / 2));
  const y = topY - (1 - ease) * 8;
  if (avoid && y + cardH > avoid.y - avoid.r && y < avoid.y + avoid.r && x < avoid.x + avoid.r && x + cardW > avoid.x - avoid.r) {
    x = Math.min(w - cardW - 6, avoid.x + avoid.r + 2);
  }

  ctx.fillStyle = COLORS.panel;
  roundRect(ctx, x, y, cardW, cardH, 6);
  ctx.fill();
  // Notch on the card's top edge pointing up at the aircraft icon.
  const nx = Math.max(x + 8, Math.min(x + cardW - 8, mx));
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.moveTo(nx, y - 5);
  ctx.lineTo(nx - 5, y);
  ctx.lineTo(nx + 5, y);
  ctx.closePath();
  ctx.fill();
  ctx.fillRect(x, y + 5, 3, cardH - 10);

  if (tag) {
    ctx.font = `800 ${tagSize}px ${FONT}`;
    ctx.fillStyle = accent;
    ctx.textAlign = 'left';
    ctx.fillText(tag, x + pad + 4, y + pad + tagSize / 2, cardW - pad * 2 - 4);
  }
  let ty = y + pad + tagH + titleSize / 2;
  lines.forEach((l, i) => {
    const size = i === 0 ? titleSize : bodySize;
    if (i > 0) ty += (i === 1 ? titleSize / 2 : bodySize / 2) + lineGap + size / 2;
    ctx.font = `${i === 0 ? 700 : 500} ${size}px ${FONT}`;
    ctx.fillStyle = i === 0 ? COLORS.text : 'rgba(255,255,255,0.85)';
    ctx.textAlign = 'left';
    ctx.fillText(l, x + pad + 4, ty, cardW - pad * 2 - 4);
  });
  ctx.restore();
}

/** When nothing is on the bar: arrow at the bar's end toward the plane with the smallest turn. */
function drawEdgeArrow(ctx: CanvasRenderingContext2D, barY: number, x0: number, x1: number, p: Plane, off: number) {
  const left = off < 0;
  const tip = left ? x0 - 4 : x1 + 4;
  const back = left ? tip + 9 : tip - 9;
  ctx.save();
  ctx.fillStyle = COLORS.focus;
  ctx.shadowColor = COLORS.shadow;
  ctx.shadowBlur = 4;
  ctx.beginPath();
  ctx.moveTo(tip, barY);
  ctx.lineTo(back, barY - 6);
  ctx.lineTo(back, barY + 6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  const text = `${flightLabel(p)} · ${Math.round(Math.abs(off))}°`;
  label(ctx, left ? x0 + 2 : x1 - 2, labelRowY(barY) + fs(16), text, fs(12), COLORS.text, left ? 'left' : 'right', true);
}

export function label(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  size: number,
  color: string,
  align: CanvasTextAlign,
  bold = false,
) {
  ctx.save();
  ctx.font = `${bold ? 700 : 600} ${size}px ${FONT}`;
  ctx.textAlign = align;
  ctx.fillStyle = color;
  ctx.shadowColor = COLORS.shadow;
  ctx.shadowBlur = 3;
  ctx.fillText(text, x, y);
  ctx.restore();
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
