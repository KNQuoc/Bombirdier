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
