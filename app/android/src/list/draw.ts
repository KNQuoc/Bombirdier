// Draws the list panel on the HUD canvas (once per eye, after drawHud), and maps a tap back to
// what it hit. Same look as the rest of the HUD: light, small text, the camera stays visible.
//
// The panel covers the right part of each eye; the radar keeps the lower left. It stays inside the
// middle of the eye because the lens edges blur.

import { aircraftStatus } from '@web/format';
import { signedDiffDeg } from '@web/geo';
import { COLORS, FONT, STATUS_COLORS, fs, planeColor, roundRect } from '@web/hud';
import type { Plane } from '@web/planes';
import { PAGE_SIZE } from './filter';
import { rowName } from './list';
import type { ListView } from './list';

/**
 * Panel edges as fractions of the eye: the right 40%, below the compass. Its left edge is at the
 * middle of the view, so main.ts hides the crosshair while the list is open.
 */
const PANEL = { x0: 0.49, x1: 0.895, y0: 0.35, y1: 0.9 };
const PAD = 6;
const DIM = 'rgba(255, 255, 255, 0.55)';
const SOFT = 'rgba(255, 255, 255, 0.85)';
/** Rows for planes below the horizon are drawn at this opacity. */
const BELOW_HORIZON_ALPHA = 0.5;
/** Emergency rows blink, like emergency icons. */
const BLINK_MS = 400;

type Rect = { x: number; y: number; w: number; h: number };

type Layout = {
  panel: Rect;
  header: Rect;
  /** Column titles. */
  columns: Rect;
  rows: Rect[];
  footer: Rect;
  prev: Rect;
  next: Rect;
};

function layout(w: number, h: number): Layout {
  const panel = { x: w * PANEL.x0, y: h * PANEL.y0, w: w * (PANEL.x1 - PANEL.x0), h: h * (PANEL.y1 - PANEL.y0) };
  const inner = { x: panel.x + PAD, w: panel.w - PAD * 2 };
  const headerH = fs(11) + fs(10) + 12;
  const columnsH = fs(8) + 5;
  const footerH = fs(10) + 9;
  const header = { ...inner, y: panel.y + 3, h: headerH };
  const columns = { ...inner, y: header.y + headerH, h: columnsH };
  const footer = { ...inner, y: panel.y + panel.h - footerH, h: footerH };
  const rowsTop = columns.y + columnsH;
  const rowH = (footer.y - rowsTop) / PAGE_SIZE;
  const rows = Array.from({ length: PAGE_SIZE }, (_, i) => ({ ...inner, y: rowsTop + i * rowH, h: rowH }));
  // Paging arrows get the outer thirds of the footer: easy to hit with a thumb.
  const third = panel.w / 3;
  const prev = { x: panel.x, y: footer.y - 4, w: third, h: footerH + 4 };
  const next = { x: panel.x + panel.w - third, y: footer.y - 4, w: third, h: footerH + 4 };
  return { panel, header, columns, rows, footer, prev, next };
}

/** Column positions as fractions of the row width. Numbers are right-aligned at their fraction. */
const COL = { n: 0, name: 0.07, type: 0.39, alt: 0.76, dist: 0.9, arrow: 0.96 };

function text(
  ctx: CanvasRenderingContext2D,
  s: string,
  x: number,
  y: number,
  size: number,
  color: string,
  align: CanvasTextAlign = 'left',
  weight = 600,
  maxWidth?: number,
) {
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.textAlign = align;
  ctx.fillStyle = color;
  ctx.fillText(s, x, y, maxWidth);
}

const rowAltitude = (p: Plane) =>
  p.onGround ? 'GND' : p.altitudeFt == null ? '–' : Math.round(p.altitudeFt).toLocaleString('en-US');

const rowDistance = (p: Plane) => (p.distanceKm < 10 ? p.distanceKm.toFixed(1) : String(Math.round(p.distanceKm)));

/** Small arrow showing which way to turn to face the plane: up = straight ahead. */
function directionArrow(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, offDeg: number, color: string) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((offDeg * Math.PI) / 180);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, -size);
  ctx.lineTo(size * 0.7, size * 0.8);
  ctx.lineTo(0, size * 0.35);
  ctx.lineTo(-size * 0.7, size * 0.8);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function wrap(ctx: CanvasRenderingContext2D, s: string, maxW: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of s.split(/\s+/)) {
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

/** Draws the list (or the opened plane) into one eye. `headingDeg` null = no direction arrows yet. */
export function drawList(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  view: ListView,
  headingDeg: number | null,
  timeMs: number,
) {
  const L = layout(w, h);
  ctx.save();
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(0, 0, 0, 0.42)';
  roundRect(ctx, L.panel.x, L.panel.y, L.panel.w, L.panel.h, 7);
  ctx.fill();
  // Text shadow keeps small type readable over a bright sky.
  ctx.shadowColor = COLORS.shadow;
  ctx.shadowBlur = 2;

  if (view.opened) drawOpened(ctx, L, view);
  else drawRows(ctx, L, view, headingDeg, timeMs);
  ctx.restore();
}

function drawRows(ctx: CanvasRenderingContext2D, L: Layout, view: ListView, headingDeg: number | null, timeMs: number) {
  const { x, w } = L.header;
  text(ctx, view.header, x, L.header.y + fs(11) / 2 + 3, fs(11), COLORS.text, 'left', 700, w);
  const chips = view.chips.length ? view.chips.join(' · ') : 'all aircraft in the air';
  text(ctx, chips, x, L.header.y + fs(11) + fs(10) / 2 + 8, fs(10), view.chips.length ? COLORS.hud : DIM, 'left', 600, w);

  const cy = L.columns.y + L.columns.h / 2;
  text(ctx, 'CALLSIGN', x + w * COL.name, cy, fs(8), DIM, 'left', 700);
  text(ctx, 'TYPE', x + w * COL.type, cy, fs(8), DIM, 'left', 700);
  text(ctx, 'ALT ft', x + w * COL.alt, cy, fs(8), DIM, 'right', 700);
  text(ctx, 'km', x + w * COL.dist, cy, fs(8), DIM, 'right', 700);

  if (!view.rows.length) {
    const r = L.rows[2];
    text(ctx, view.chips.length ? 'Nothing matches' : 'No planes yet', x + w / 2, r.y + r.h / 2, fs(11), SOFT, 'center');
  }

  const blinkOff = Math.floor(timeMs / BLINK_MS) % 2 === 1;
  view.rows.forEach((row, i) => {
    const r = L.rows[i];
    const y = r.y + r.h / 2;
    const p = row.plane;
    const status = aircraftStatus(p);
    // White for ordinary planes; status colors and the home fleet's color stand out.
    const nameColor = status === 'normal' && !p.accent ? COLORS.text : planeColor(p, status);
    ctx.save();
    ctx.globalAlpha = status === 'emergency' && blinkOff ? 0.35 : row.belowHorizon ? BELOW_HORIZON_ALPHA : 1;
    const size = fs(10.5);
    text(ctx, String(row.n), x + w * COL.n, y, fs(9), DIM, 'left', 700);
    text(ctx, rowName(p), x + w * COL.name, y, size, nameColor, 'left', 700, w * (COL.type - COL.name) - 3);
    text(ctx, p.typeCode ?? (p.kind === 'helicopter' ? 'HELI' : '–'), x + w * COL.type, y, size, SOFT, 'left', 500, w * 0.15);
    text(ctx, rowAltitude(p), x + w * COL.alt, y, size, SOFT, 'right', 500, w * 0.21);
    text(ctx, rowDistance(p), x + w * COL.dist, y, size, SOFT, 'right', 500);
    if (headingDeg != null) {
      directionArrow(ctx, x + w * COL.arrow, y, fs(5), signedDiffDeg(p.bearingDeg, headingDeg), nameColor);
    }
    ctx.restore();
  });

  const fy = L.footer.y + L.footer.h / 2;
  const cx = L.panel.x + L.panel.w / 2;
  const many = view.pages > 1;
  if (many) {
    text(ctx, '▲', L.prev.x + L.prev.w / 2, fy, fs(10), view.page > 0 ? COLORS.hud : 'rgba(255,255,255,0.25)', 'center');
    text(ctx, '▼', L.next.x + L.next.w / 2, fy, fs(10), view.page < view.pages - 1 ? COLORS.hud : 'rgba(255,255,255,0.25)', 'center');
  }
  const belowAny = view.rows.some((r) => r.belowHorizon);
  const foot = [many ? `${view.page + 1} / ${view.pages}` : null, belowAny ? 'dim = below horizon' : null].filter(Boolean).join(' · ');
  if (foot) text(ctx, foot, cx, fy, fs(9), DIM, 'center', 600, L.panel.w / 3 + 20);
}

function drawOpened(ctx: CanvasRenderingContext2D, L: Layout, view: ListView) {
  const o = view.opened!;
  const { x, w } = L.header;
  const status = aircraftStatus(o.plane);
  const accent = status === 'normal' ? (o.plane.accent ?? COLORS.focus) : STATUS_COLORS[status];
  let y = L.panel.y + 6 + fs(10) / 2;
  text(ctx, '‹ list', x, y, fs(10), COLORS.hud, 'left', 700);
  y += fs(10) / 2 + 8;

  if (o.tag) {
    text(ctx, o.tag, x, y + fs(9) / 2, fs(9), accent, 'left', 800, w);
    y += fs(9) + 4;
  }
  o.lines.forEach((line, i) => {
    const title = i === 0;
    const last = i === o.lines.length - 1;
    const size = title ? fs(14) : fs(11.5);
    ctx.font = `${title ? 700 : 500} ${size}px ${FONT}`;
    for (const part of wrap(ctx, line, w)) {
      text(ctx, part, x, y + size / 2, size, title ? COLORS.text : last ? accent : SOFT, 'left', title ? 700 : last ? 700 : 500, w);
      y += size + 4;
    }
    if (title) y += 2;
  });

  if (o.inAr) {
    y += 4;
    ctx.font = `600 ${fs(10)}px ${FONT}`;
    for (const part of wrap(ctx, 'In view range: follow the compass arrow to its pulsing bracket.', w)) {
      text(ctx, part, x, y + fs(10) / 2, fs(10), DIM, 'left', 600, w);
      y += fs(10) + 3;
    }
  }
}

export type ListHit =
  | { type: 'row'; n: number }
  | { type: 'page'; direction: 'next' | 'prev' }
  | { type: 'back' }
  /** Inside the panel but on nothing: swallow the tap so it doesn't reach the view behind. */
  | { type: 'panel' };

const inside = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/** What a tap at (x, y) in eye coordinates hits, or null if it's outside the panel. */
export function hitList(x: number, y: number, w: number, h: number, view: ListView): ListHit | null {
  const L = layout(w, h);
  if (!inside(L.panel, x, y)) return null;
  if (view.opened) return { type: 'back' };
  if (view.pages > 1 && inside(L.prev, x, y)) return { type: 'page', direction: 'prev' };
  if (view.pages > 1 && inside(L.next, x, y)) return { type: 'page', direction: 'next' };
  const i = L.rows.findIndex((r) => y >= r.y && y < r.y + r.h);
  if (i >= 0 && view.rows[i]) return { type: 'row', n: view.rows[i].n };
  return { type: 'panel' };
}
