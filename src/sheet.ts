import { HALF, type Pt } from './geo';
import type { MapData, Polygon } from './osm';
import type { Piece, Printed, ScoreResult } from './score';

export type Mode = 'landmarks' | 'roads' | 'alleys' | 'buildings';

/** Which streets each help level prints, for scoring. */
export const printedFor = (mode: Mode): Printed => (mode === 'landmarks' ? 'none' : mode === 'alleys' ? 'alleys' : 'major');

/** Canvas colours. The legend in style.css uses the same values. */
export const INK = {
  paper: '#f6f7f0',
  grid: '#d3e2d0',
  gridMajor: '#b9d0b5',
  graphite: '#34383a',
  pin: '#e3342f',
  remembered: '#2350c8',
  forgotten: '#b5c0b2',
  imaginary: '#f6a23c',
  hint: '#8a978a',
  label: '#5f6d5e',
  water: '#a6cfea',
  park: '#d6e8c4',
  wood: '#bfd9a8',
  landmark: '#3f4a40',
  rail: '#7d867b',
  building: '#e1e7da',
};

export const FONT = '"Familjen Grotesk", system-ui, sans-serif';

/** Size-relative unit: 1 at a 600 px sheet. */
const unit = (size: number) => size / 600;
/** The same for labels, which stop shrinking at about 9 px so a phone-width sheet stays readable. */
const textUnit = (size: number) => Math.max(unit(size), 0.8);

export function toPx(p: Pt, size: number): [number, number] {
  return [((p.x + HALF) / (2 * HALF)) * size, ((HALF - p.y) / (2 * HALF)) * size];
}

export function toMetres(px: number, py: number, size: number): Pt {
  return { x: (px / size) * 2 * HALF - HALF, y: HALF - (py / size) * 2 * HALF };
}

export function drawPaper(ctx: CanvasRenderingContext2D, size: number): void {
  ctx.fillStyle = INK.paper;
  ctx.fillRect(0, 0, size, size);
  // A line every 100 m, darker through the pin. Finer than this and tracing the grid alone scores
  // on any grid-plan district.
  const step = size / 10;
  ctx.lineWidth = Math.max(1, unit(size) * 0.8);
  for (let i = 1; i < 10; i++) {
    ctx.strokeStyle = i === 5 ? INK.gridMajor : INK.grid;
    const v = Math.round(i * step) + 0.5;
    ctx.beginPath();
    ctx.moveTo(v, 0);
    ctx.lineTo(v, size);
    ctx.moveTo(0, v);
    ctx.lineTo(size, v);
    ctx.stroke();
  }
}

function path(ctx: CanvasRenderingContext2D, pts: Pt[], size: number): void {
  ctx.beginPath();
  pts.forEach((p, i) => {
    const [x, y] = toPx(p, size);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
}

/** Parks, woods, water, railways, and building footprints when asked for. */
function drawContext(ctx: CanvasRenderingContext2D, size: number, map: MapData, buildings: boolean): void {
  const u = unit(size);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.fillStyle = INK.park;
  for (const p of map.parks) fillPolygon(ctx, p, size);
  ctx.fillStyle = INK.wood;
  for (const w of map.woods) fillPolygon(ctx, w, size);
  ctx.fillStyle = INK.water;
  for (const w of map.waterAreas) fillPolygon(ctx, w, size);
  if (buildings) {
    ctx.fillStyle = INK.building;
    for (const b of map.buildings) fillPolygon(ctx, b, size);
  }
  ctx.strokeStyle = INK.water;
  ctx.lineWidth = 7 * u;
  for (const w of map.water) {
    path(ctx, w, size);
    ctx.stroke();
  }
  ctx.strokeStyle = INK.rail;
  for (const r of map.rail) {
    ctx.lineWidth = 1.6 * u;
    path(ctx, r, size);
    ctx.stroke();
    drawRailTicks(ctx, r, size);
  }
}

function fillPolygon(ctx: CanvasRenderingContext2D, poly: Polygon, size: number): void {
  ctx.beginPath();
  for (const ring of poly) {
    ring.forEach((p, i) => {
      const [x, y] = toPx(p, size);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
  }
  ctx.fill('evenodd');
}

/** Shortens a label to fit `max` pixels, with an ellipsis. */
function fitLabel(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  const chars = [...text];
  while (chars.length > 1 && ctx.measureText(`${chars.join('').trimEnd()}…`).width > max) chars.pop();
  return `${chars.join('').trimEnd()}…`;
}

/**
 * Named places as dots with labels, to hang a memory on. A label that would collide with one
 * already placed, or run off the sheet, is left out together with its dot.
 */
function drawLandmarks(ctx: CanvasRenderingContext2D, size: number, map: MapData): void {
  const u = textUnit(size);
  // The scale bar and north arrow (drawFurniture) are already there.
  const placed: [number, number, number, number][] = [
    [0, size - 40 * u, 18 * u + size / 5 + 6 * u, size],
    [size - 40 * u, 0, size, 60 * u],
  ];
  ctx.save();
  ctx.font = `600 ${11 * u}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const l of map.landmarks) {
    const [x, y] = toPx(l.at, size);
    // Some names run a third of the sheet (Prague's university faculties).
    const name = fitLabel(ctx, l.name, size / 4);
    const w = ctx.measureText(name).width;
    const box: [number, number, number, number] = [x - w / 2 - 3 * u, y - 5 * u, x + w / 2 + 3 * u, y + 20 * u];
    if (box[0] < 0 || box[2] > size || box[1] < 0 || box[3] > size) continue;
    if (placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
    placed.push(box);
    ctx.fillStyle = INK.paper;
    ctx.strokeStyle = INK.landmark;
    ctx.lineWidth = 1.6 * u;
    ctx.beginPath();
    // Stations get a square, mountain tops a triangle, everything else a circle.
    if (l.cls === 'railway') ctx.rect(x - 4 * u, y - 4 * u, 8 * u, 8 * u);
    else if (l.cls === 'peak') {
      ctx.moveTo(x, y - 5 * u);
      ctx.lineTo(x + 5 * u, y + 4 * u);
      ctx.lineTo(x - 5 * u, y + 4 * u);
      ctx.closePath();
    } else ctx.arc(x, y, 4 * u, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.lineWidth = 3.5 * u;
    ctx.strokeStyle = INK.paper;
    ctx.strokeText(name, x, y + 6 * u);
    ctx.fillStyle = INK.landmark;
    ctx.fillText(name, x, y + 6 * u);
  }
  ctx.restore();
}

function drawRailTicks(ctx: CanvasRenderingContext2D, pts: Pt[], size: number): void {
  const u = unit(size);
  const gap = 9 * u;
  let carry = 0;
  ctx.beginPath();
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = toPx(pts[i]!, size);
    const [bx, by] = toPx(pts[i + 1]!, size);
    const len = Math.hypot(bx - ax, by - ay);
    if (len === 0) continue;
    const nx = (-(by - ay) / len) * 3 * u;
    const ny = ((bx - ax) / len) * 3 * u;
    for (let d = gap - carry; d < len; d += gap) {
      const x = ax + ((bx - ax) * d) / len;
      const y = ay + ((by - ay) * d) / len;
      ctx.moveTo(x - nx, y - ny);
      ctx.lineTo(x + nx, y + ny);
    }
    carry = (carry + len) % gap;
  }
  ctx.stroke();
}

function drawHintRoads(ctx: CanvasRenderingContext2D, size: number, map: MapData): void {
  const u = unit(size);
  const major = map.roads.filter((r) => r.cls === 'major');
  ctx.strokeStyle = INK.hint;
  ctx.lineWidth = 2.6 * u;
  ctx.setLineDash([9 * u, 6 * u]);
  for (const r of major) {
    path(ctx, r.pts, size);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // One label per road name, on its longest straight stretch.
  const t = textUnit(size);
  const best = new Map<string, { a: Pt; b: Pt; len: number }>();
  for (const r of map.named) {
    if (r.cls !== 'major') continue;
    if (!r.name) continue;
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const a = r.pts[i]!;
      const b = r.pts[i + 1]!;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len > (best.get(r.name)?.len ?? 0)) best.set(r.name, { a, b, len });
    }
  }
  ctx.font = `500 ${11.5 * t}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const [name, { a, b }] of best) {
    const [ax, ay] = toPx(a, size);
    const [bx, by] = toPx(b, size);
    if (ctx.measureText(name).width > Math.hypot(bx - ax, by - ay) * 0.9) continue;
    let angle = Math.atan2(by - ay, bx - ax);
    if (angle > Math.PI / 2) angle -= Math.PI;
    if (angle < -Math.PI / 2) angle += Math.PI;
    ctx.save();
    ctx.translate((ax + bx) / 2, (ay + by) / 2);
    ctx.rotate(angle);
    ctx.lineWidth = 4 * t;
    ctx.strokeStyle = INK.paper;
    ctx.strokeText(name, 0, -7 * t);
    ctx.fillStyle = INK.label;
    ctx.fillText(name, 0, -7 * t);
    ctx.restore();
  }
}

export function drawPin(ctx: CanvasRenderingContext2D, size: number): void {
  const u = unit(size);
  const cx = size / 2;
  const cy = size / 2;
  const r = 7 * u;
  ctx.save();
  ctx.fillStyle = INK.pin;
  ctx.beginPath();
  ctx.arc(cx, cy - 2.2 * r, r, Math.PI * 0.82, Math.PI * 0.18);
  ctx.lineTo(cx, cy);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = INK.paper;
  ctx.beginPath();
  ctx.arc(cx, cy - 2.2 * r, r * 0.38, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Scale bar and north arrow. */
export function drawFurniture(ctx: CanvasRenderingContext2D, size: number): void {
  const u = unit(size);
  const pad = 18 * u;
  const bar = size / 5; // 200 m
  ctx.save();
  ctx.strokeStyle = INK.graphite;
  ctx.fillStyle = INK.graphite;
  ctx.lineWidth = 1.5 * u;
  const y = size - pad;
  ctx.beginPath();
  ctx.moveTo(pad, y - 5 * u);
  ctx.lineTo(pad, y);
  ctx.lineTo(pad + bar, y);
  ctx.lineTo(pad + bar, y - 5 * u);
  ctx.stroke();
  ctx.font = `500 ${11 * u}px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText('200 m', pad + 4 * u, y - 4 * u);

  const nx = size - pad - 6 * u;
  const ny = pad + 4 * u;
  ctx.beginPath();
  ctx.moveTo(nx, ny);
  ctx.lineTo(nx + 6 * u, ny + 16 * u);
  ctx.lineTo(nx, ny + 12 * u);
  ctx.lineTo(nx - 6 * u, ny + 16 * u);
  ctx.closePath();
  ctx.fill();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('N', nx, ny + 19 * u);
  ctx.restore();
}

export function drawStrokes(ctx: CanvasRenderingContext2D, size: number, strokes: Pt[][]): void {
  const u = unit(size);
  ctx.save();
  ctx.strokeStyle = INK.graphite;
  ctx.globalAlpha = 0.88;
  ctx.lineWidth = 2.3 * u;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of strokes) {
    path(ctx, s, size);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Everything under the player's pencil while drawing. Cached by the caller. `printed` is the side
 * streets the Side streets level prints (ScoreResult.printed).
 */
export function drawBase(
  ctx: CanvasRenderingContext2D,
  size: number,
  map: MapData | null,
  mode: Mode,
  printed: Piece[] = [],
): void {
  drawPaper(ctx, size);
  if (map) {
    drawContext(ctx, size, map, mode === 'buildings');
    if (printedFor(mode) === 'major') drawHintRoads(ctx, size, map);
    drawPrintedStreets(ctx, size, printed);
    drawLandmarks(ctx, size, map);
  }
  drawFurniture(ctx, size);
}

/** The side streets printed on the Side streets level: thin, solid, unnamed. */
function drawPrintedStreets(ctx: CanvasRenderingContext2D, size: number, printed: Piece[]): void {
  ctx.save();
  ctx.lineCap = 'round';
  // At least about 1 px, or they all but vanish on a phone-width sheet.
  drawPieces(ctx, size, printed, INK.hint, Math.max(1.5 * unit(size), 1.1));
  ctx.restore();
}

function drawPieces(ctx: CanvasRenderingContext2D, size: number, pieces: Piece[], color: string, width: number): void {
  if (!pieces.length) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  for (const p of pieces) {
    const [ax, ay] = toPx(p.a, size);
    const [bx, by] = toPx(p.b, size);
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
  }
  ctx.stroke();
}

/**
 * The reveal: real streets over the drawing. `progress` (0–1) is how much of the real network has
 * been inked in so far.
 */
export function drawResult(
  ctx: CanvasRenderingContext2D,
  size: number,
  map: MapData,
  mode: Mode,
  strokes: Pt[][],
  result: ScoreResult,
  progress = 1,
): void {
  const u = unit(size);
  drawPaper(ctx, size);
  // Every level reveals the buildings, so each street sits in its blocks.
  drawContext(ctx, size, map, true);
  // Under the result ink, so their paper halos don't cut through it.
  drawLandmarks(ctx, size, map);
  ctx.lineCap = 'round';
  const shown = result.roadPieces.slice(0, Math.ceil(result.roadPieces.length * progress));
  // Alleys weren't asked for, so a forgotten one stays faint; a remembered one still shows.
  drawPieces(ctx, size, shown.filter((p) => !p.hit && !p.key), INK.forgotten, 1.6 * u);
  drawPieces(ctx, size, shown.filter((p) => !p.hit && p.key), INK.forgotten, 3.8 * u);
  drawPieces(ctx, size, shown.filter((p) => p.hit && !p.key), INK.remembered, 2.4 * u);
  drawPieces(ctx, size, shown.filter((p) => p.hit && p.key), INK.remembered, 4.4 * u);
  if (printedFor(mode) === 'major') drawHintRoads(ctx, size, map);
  drawPrintedStreets(ctx, size, result.printed);
  ctx.globalAlpha = 0.75;
  drawPieces(ctx, size, result.strokePieces.filter((p) => !p.hit), INK.imaginary, 8 * u);
  ctx.globalAlpha = 1;
  drawStrokes(ctx, size, strokes);
  drawPin(ctx, size);
  drawFurniture(ctx, size);
}
