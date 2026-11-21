// The HUD's marker for a sky filter (see sky-filter.ts). Apart from that file so its logic can be
// tested without a browser.

import { COLORS, FONT, fs, roundRect } from '@web/hud';
import type { ListFilter } from './list/filter';
import { skyFilterLabel } from './sky-filter';

const CHIP_Y = 0.095;

/** A small "SKY · only helicopters" marker above the compass, so hidden planes are never a mystery. */
export function drawSkyFilterChip(ctx: CanvasRenderingContext2D, w: number, h: number, filter: ListFilter) {
  const text = `SKY · only ${skyFilterLabel(filter)}`;
  const size = fs(9.5);
  ctx.save();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.font = `700 ${size}px ${FONT}`;
  const tw = Math.min(w * 0.6, ctx.measureText(text).width);
  const pw = tw + 14;
  const ph = size + 8;
  ctx.fillStyle = COLORS.panel;
  roundRect(ctx, (w - pw) / 2, h * CHIP_Y - ph / 2, pw, ph, ph / 2);
  ctx.fill();
  ctx.strokeStyle = COLORS.focus;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = COLORS.focus;
  ctx.fillText(text, w / 2, h * CHIP_Y, w * 0.6);
  ctx.restore();
}
