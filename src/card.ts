import type { Pt } from './geo';
import type { MapData } from './osm';
import type { ScoreResult } from './score';
import { FONT, INK, type Mode, drawResult } from './sheet';

const W = 1200;
const H = 675;
const MAT = '#26463b';
const MAT_INK = '#e9f0e6';
const MAT_SOFT = '#a9c2b2';

const MODE_NAME: Record<Mode, string> = {
  quiz: 'One street at a time',
  landmarks: 'Landmarks given',
  roads: 'Main roads given',
  alleys: 'Side streets given',
  buildings: 'Buildings given',
};

/** Draws the share image: the revealed sheet on the left, the score on the right. */
export async function makeCard(
  map: MapData,
  mode: Mode,
  strokes: Pt[][],
  result: ScoreResult,
  place: string,
  verdict: string,
): Promise<Blob> {
  await document.fonts.load(`700 48px ${FONT}`);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available');

  ctx.fillStyle = MAT;
  ctx.fillRect(0, 0, W, H);

  const pad = 40;
  const size = H - pad * 2;
  ctx.save();
  ctx.translate(pad, pad);
  ctx.beginPath();
  ctx.rect(0, 0, size, size);
  ctx.clip();
  drawResult(ctx, size, map, mode, strokes, result);
  ctx.restore();

  const x = pad + size + 56;
  const maxW = W - x - pad;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  ctx.fillStyle = MAT_SOFT;
  ctx.font = `500 26px ${FONT}`;
  ctx.fillText('Memory Lane', x, pad + 30);

  ctx.fillStyle = MAT_INK;
  ctx.font = `600 34px ${FONT}`;
  const placeLines = wrap(ctx, place, maxW).slice(0, 2);
  placeLines.forEach((line, i) => ctx.fillText(line, x, pad + 84 + i * 40));
  const below = pad + 84 + (placeLines.length - 1) * 40;

  ctx.fillStyle = MAT_SOFT;
  ctx.font = `500 22px ${FONT}`;
  ctx.fillText(`Drawn from memory, ${MODE_NAME[mode].toLowerCase()}`, x, below + 36);

  ctx.fillStyle = INK.pin;
  ctx.font = `700 168px ${FONT}`;
  ctx.fillText(String(result.score), x - 6, below + 210);
  const scoreW = ctx.measureText(String(result.score)).width;
  ctx.fillStyle = MAT_SOFT;
  ctx.font = `600 34px ${FONT}`;
  ctx.fillText('/ 100', x + scoreW + 8, below + 210);

  ctx.fillStyle = MAT_INK;
  ctx.font = `500 26px ${FONT}`;
  wrap(ctx, verdict, maxW)
    .slice(0, 3)
    .forEach((line, i) => ctx.fillText(line, x, below + 262 + i * 34));

  ctx.fillStyle = MAT_SOFT;
  ctx.font = `500 22px ${FONT}`;
  ctx.fillText(`Streets remembered ${pct(result.recall)}`, x, H - pad - 44);
  // On the one-street-at-a-time level a line only counts on the street asked for.
  const lines = mode === 'quiz' ? 'Lines on the asked streets' : 'Lines on real streets';
  ctx.fillText(`${lines} ${pct(result.precision)}`, x, H - pad - 12);

  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not create the image'))), 'image/png'),
  );
}

export const pct = (v: number) => `${Math.round(v * 100)}%`;

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  // Each token carries the separator that goes before it. A word too wide for a line (a name in a
  // script written without spaces, say) breaks between characters.
  const tokens = text.split(' ').flatMap((word) =>
    ctx.measureText(word).width > maxW ? [...word].map((ch, i) => ({ t: ch, sep: i === 0 ? ' ' : '' })) : [{ t: word, sep: ' ' }],
  );
  const lines: string[] = [];
  let line = '';
  for (const { t, sep } of tokens) {
    const next = line ? line + sep + t : t;
    if (line && ctx.measureText(next).width > maxW) {
      lines.push(line);
      line = t;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}
