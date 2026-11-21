// The legend of the airspace view (control.ts): which colour is which controller, how many planes
// each has in view, and the last handoff heard. Lower right of each eye, opposite the radar.

import { COLORS, FONT, fs, roundRect } from '@web/hud';
import type { LegendRow } from './control';

const LEFT = 0.61;
const WIDTH = 0.27;
const BOTTOM = 0.8;

export function drawAirspaceLegend(ctx: CanvasRenderingContext2D, w: number, h: number, rows: LegendRow[], lastHandoff: string | null) {
  if (!rows.length && !lastHandoff) return;
  const size = fs(9);
  const lineH = size * 1.55;
  const pad = size * 0.7;
  const lines = rows.length + 1 + (lastHandoff ? 1 : 0);
  const pw = w * WIDTH;
  const ph = lines * lineH + pad * 1.6;
  const x = w * LEFT;
  const y = h * BOTTOM - ph;
  ctx.save();
  ctx.fillStyle = COLORS.panel;
  roundRect(ctx, x, y, pw, ph, 6);
  ctx.fill();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const dot = size * 0.42;
  const textX = x + pad + dot * 2 + size * 0.5;
  const textW = pw - (textX - x) - pad;
  let cy = y + pad * 0.8 + lineH / 2;
  for (const row of rows) {
    ctx.fillStyle = row.color;
    ctx.beginPath();
    ctx.arc(x + pad + dot, cy, dot, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = `600 ${size}px ${FONT}`;
    ctx.fillStyle = COLORS.text;
    ctx.fillText(`${row.label} ${row.count}`, textX, cy, textW);
    cy += lineH;
  }
  ctx.font = `500 ${size * 0.9}px ${FONT}`;
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.fillText('bright = heard · faint = likely', x + pad, cy, pw - pad * 2);
  if (lastHandoff) {
    cy += lineH;
    ctx.font = `600 ${size * 0.9}px ${FONT}`;
    ctx.fillStyle = COLORS.focus;
    ctx.fillText(lastHandoff, x + pad, cy, pw - pad * 2);
  }
  ctx.restore();
}
