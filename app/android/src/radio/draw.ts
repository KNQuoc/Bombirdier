// The radio subtitle: the call that was just heard, with the plane it's about, at the bottom of each eye.
//
//   📻 DAL1830  descend and maintain 4,000
//   📻 N337BG   radar contact  ·  62 km northwest          (a plane outside the AR view: where it is)

import { COLORS, FONT, fs, planeColor, roundRect } from '@web/hud';
import { compassWord, rowName } from '../list/list';
import type { HeardCall } from './radio';

/** Vertical center of the subtitle, as a fraction of the eye height: under the voice subtitles. */
const RADIO_Y = 0.9;
const MAX_WIDTH = 0.72;

/** The call without its opening callsign: "Delta 1830, descend and maintain 4,000." -> "descend and maintain 4,000". */
export function callBody(text: string): string {
  const comma = text.indexOf(',');
  // A callsign comes first and is followed by a comma within the first few words.
  const body = comma > 0 && comma <= 45 && /\d|november|bravo|golf|alpha|charlie|tango|zulu/i.test(text.slice(0, comma)) ? text.slice(comma + 1) : text;
  return body.trim().replace(/\.$/, '');
}

function fit(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let cut = text;
  while (cut.length > 4 && ctx.measureText(`${cut}…`).width > maxW) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/**
 * Draws the latest call into one eye. `arRadiusKm` decides whether to say where the plane is: one
 * in the AR view has a pulsing bracket to look at, one outside it doesn't.
 */
export function drawRadio(ctx: CanvasRenderingContext2D, w: number, h: number, call: HeardCall, arRadiusKm: number) {
  const { plane, event } = call;
  const name = plane ? rowName(plane) : (event.callsignTokens[0] ?? '');
  const far = plane && plane.distanceKm > arRadiusKm ? `${Math.round(plane.distanceKm)} km ${compassWord(plane.bearingDeg)}` : '';
  const size = fs(11);
  const pad = 7;
  const gap = 6;

  ctx.save();
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${size}px ${FONT}`;
  const head = `📻 ${name}`.trim();
  const headW = ctx.measureText(head).width;
  ctx.font = `500 ${fs(10)}px ${FONT}`;
  const farText = far ? `  ·  ${far}` : '';
  const farW = ctx.measureText(farText).width;
  ctx.font = `500 ${size}px ${FONT}`;
  const body = fit(ctx, callBody(event.text), w * MAX_WIDTH - headW - farW - gap - pad * 2);
  const bodyW = ctx.measureText(body).width;

  const boxW = headW + gap + bodyW + farW + pad * 2;
  const boxH = size + 10;
  const x = (w - boxW) / 2;
  const y = h * RADIO_Y - boxH / 2;
  ctx.fillStyle = COLORS.panel;
  roundRect(ctx, x, y, boxW, boxH, boxH / 2);
  ctx.fill();

  const cy = y + boxH / 2;
  ctx.textAlign = 'left';
  ctx.font = `700 ${size}px ${FONT}`;
  // A known plane's name in its own color (yellow, or orange for a BGSU plane); an unknown one stays grey.
  ctx.fillStyle = plane ? (plane.accent ?? COLORS.focus) : 'rgba(255,255,255,0.6)';
  if (plane && !plane.accent && planeColor(plane) !== COLORS.hud) ctx.fillStyle = planeColor(plane);
  ctx.fillText(head, x + pad, cy);
  ctx.font = `500 ${size}px ${FONT}`;
  ctx.fillStyle = COLORS.text;
  ctx.fillText(body, x + pad + headW + gap, cy);
  if (farText) {
    ctx.font = `500 ${fs(10)}px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.fillText(farText, x + pad + headW + gap + bodyW, cy);
  }
  ctx.restore();
}

/** What the HUD shows while you're connected to a feed. */
export type ConnectedView = {
  name: string;
  /** Is the feed coming in on the Mac right now? */
  live: boolean;
  muted: boolean;
  /** The transcript lines to show, oldest first; null = transcript hidden. */
  lines: HeardCall[] | null;
};

const PILL_Y = 0.145;
/** The transcript takes the bottom of the view, where the radar is otherwise. */
const TRANSCRIPT_BOTTOM = 0.8;
const TRANSCRIPT_X = 0.16;
const TRANSCRIPT_W = 0.68;

/**
 * "📻 Toledo Approach · LIVE 🔇" near the top, and the last few calls scrolling at the bottom: the
 * newest lowest and brightest, each starting with its callsign (tinted when it's a plane the app knows).
 */
export function drawConnected(ctx: CanvasRenderingContext2D, w: number, h: number, view: ConnectedView, showTranscript: boolean) {
  ctx.save();
  ctx.textBaseline = 'middle';

  // The pill.
  const size = fs(10.5);
  const state = view.live ? 'LIVE' : 'NO SIGNAL';
  const text = `📻 ${view.name} · ${state}${view.muted ? '  🔇' : ''}${view.lines ? '  💬' : ''}`;
  ctx.font = `700 ${size}px ${FONT}`;
  const tw = ctx.measureText(text).width;
  const pw = tw + 16;
  const ph = size + 9;
  const px = (w - pw) / 2;
  const py = h * PILL_Y - ph / 2;
  ctx.fillStyle = COLORS.panel;
  roundRect(ctx, px, py, pw, ph, ph / 2);
  ctx.fill();
  ctx.strokeStyle = view.live ? 'rgba(76, 217, 100, 0.9)' : 'rgba(255, 59, 48, 0.9)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.fillStyle = COLORS.text;
  ctx.fillText(text, w / 2, h * PILL_Y);

  if (view.lines && showTranscript) {
    const lineSize = fs(10.5);
    const lineH = lineSize + 7;
    const x = w * TRANSCRIPT_X;
    const maxW = w * TRANSCRIPT_W;
    const lines = view.lines;
    const top = h * TRANSCRIPT_BOTTOM - lineH * Math.max(1, lines.length);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.42)';
    roundRect(ctx, x - 7, top - 4, maxW + 14, lineH * Math.max(1, lines.length) + 8, 7);
    ctx.fill();
    ctx.textAlign = 'left';
    ctx.shadowColor = COLORS.shadow;
    ctx.shadowBlur = 2;
    if (!lines.length) {
      ctx.font = `500 ${lineSize}px ${FONT}`;
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillText(view.live ? 'Listening… nothing said yet' : 'Nothing coming in from the Mac', x, top + lineH / 2);
    }
    lines.forEach((call, i) => {
      const y = top + lineH * i + lineH / 2;
      const newest = i === lines.length - 1;
      const { plane, event } = call;
      const name = plane ? rowName(plane) : (event.callsignTokens[0] ?? '');
      ctx.globalAlpha = newest ? 1 : 0.45 + (0.35 * i) / Math.max(1, lines.length - 1);
      ctx.font = `700 ${lineSize}px ${FONT}`;
      const nameW = name ? ctx.measureText(name).width + 7 : 0;
      if (name) {
        ctx.fillStyle = plane ? (plane.accent ?? (planeColor(plane) !== COLORS.hud ? planeColor(plane) : COLORS.focus)) : 'rgba(255,255,255,0.6)';
        ctx.fillText(name, x, y);
      }
      ctx.font = `500 ${lineSize}px ${FONT}`;
      ctx.fillStyle = COLORS.text;
      // With no callsign found, the whole call is shown as it was heard.
      ctx.fillText(fit(ctx, name ? callBody(event.text) : event.text.replace(/\.$/, ''), maxW - nameW), x + nameW, y);
    });
  }
  ctx.restore();
}
