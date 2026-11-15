/**
 * Scoring calibration against live map data. Not part of `npm test`: it needs the network and
 * takes a few seconds per place. Run with `npm run calibrate` after any change to score.ts or to
 * what osm.ts counts as a street. docs/scoring.md says what each check guards against.
 */
import { describe, expect, it } from 'vitest';
import { type Pt, distToSegment } from '../src/geo';
import { type MapData, fetchMap } from '../src/osm';
import { type RoadPiece, scoreDrawing } from '../src/score';

const PLACES = {
  'Seogyo-dong, Seoul': { lat: 37.5536, lon: 126.9227 },
  'Shibuya, Tokyo': { lat: 35.6595, lon: 139.7005 },
  'Le Marais, Paris': { lat: 48.8566, lon: 2.3522 },
  'Midtown, Manhattan': { lat: 40.7549, lon: -73.984 },
  // Expressways, ramps and underpasses, none of which should be asked for.
  'Yeouido, Seoul': { lat: 37.526, lon: 126.925 },
  // With the main roads printed, nearly everything left is numbered side streets.
  'Gangnam, Seoul': { lat: 37.4979, lon: 127.0276 },
  // Sparse: with the roads printed, one street (잠실로) was most of what was asked.
  'Jamsil, Seoul': { lat: 37.5133, lon: 127.1002 },
};

/** Whether point p lies within d metres of any segment of the lines. */
const onLines = (p: Pt, lines: Pt[][], d: number) =>
  lines.some((l) => l.some((a, i) => i > 0 && distToSegment(p, l[i - 1]!, a) <= d));
const mid = (p: { a: Pt; b: Pt }): Pt => ({ x: (p.a.x + p.b.x) / 2, y: (p.a.y + p.b.y) / 2 });

const line = (x0: number, y0: number, x1: number, y1: number): Pt[] => [
  { x: x0, y: y0 },
  { x: x1, y: y1 },
];

/** A careful player: the real line, 8 m off to one side, with ±3 m of hand jitter every 2 m. */
function byHand(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len === 0) continue;
    const nx = -(b.y - a.y) / len;
    const ny = (b.x - a.x) / len;
    const n = Math.max(1, Math.ceil(len / 2));
    for (let k = 0; k < n; k++) {
      out.push({
        x: a.x + ((b.x - a.x) * k) / n + nx * 8 + Math.sin(k) * 3,
        y: a.y + ((b.y - a.y) * k) / n + ny * 8 + Math.cos(k * 1.3) * 3,
      });
    }
  }
  return out;
}

/** Joins consecutive scored pieces that `keep` accepts back into lines. */
function linesOf(pieces: RoadPiece[], keep: (p: RoadPiece) => boolean): Pt[][] {
  const out: Pt[][] = [];
  let cur: Pt[] | null = null;
  let last: Pt | null = null;
  for (const p of pieces) {
    if (!keep(p)) {
      cur = null;
      continue;
    }
    if (cur && last && last.x === p.a.x && last.y === p.a.y) cur.push(p.b);
    else out.push((cur = [p.a, p.b]));
    last = p.b;
  }
  return out;
}

function grid(spacing: number): Pt[][] {
  const g: Pt[][] = [];
  for (let v = -500 + spacing; v < 500; v += spacing) g.push(line(-500, v, 500, v), line(v, -500, v, 500));
  return g;
}

const maps = new Map<string, Promise<MapData>>();
const mapOf = (name: keyof typeof PLACES) => {
  if (!maps.has(name)) maps.set(name, fetchMap(PLACES[name], 500));
  return maps.get(name)!;
};

describe.each(Object.keys(PLACES) as (keyof typeof PLACES)[])('%s', (name) => {
  it('scores a careful full drawing at 95 or more', async () => {
    const m = await mapOf(name);
    const r = scoreDrawing(m.roads, m.roads.map((x) => byHand(x.pts)), false, m.named, m.tunnels);
    console.log(`${name}: full ${r.score} (recall ${r.recall.toFixed(2)}, precision ${r.precision.toFixed(2)})`);
    expect(r.score).toBeGreaterThanOrEqual(95);
  });

  it('scores half the sheet in between', async () => {
    const m = await mapOf(name);
    // The west half. Every other street would draw one side of each dual carriageway, which
    // credits the other side too (Gangnam scored 96).
    const pieces = scoreDrawing(m.roads, [], false, m.named, m.tunnels).roadPieces;
    const r = scoreDrawing(m.roads, linesOf(pieces, (p) => mid(p).x < 0).map(byHand), false, m.named, m.tunnels);
    console.log(`${name}: half ${r.score}`);
    expect(r.score).toBeGreaterThan(50);
    expect(r.score).toBeLessThan(90);
  });

  it('scores drawing only the key streets at 95 or more', async () => {
    const m = await mapOf(name);
    const pieces = scoreDrawing(m.roads, [], false, m.named, m.tunnels).roadPieces;
    const r = scoreDrawing(m.roads, linesOf(pieces, (p) => p.key).map(byHand), false, m.named, m.tunnels);
    const share = pieces.filter((p) => p.key).length / pieces.length;
    console.log(`${name}: key only ${r.score} (key share ${(share * 100).toFixed(0)}% of pieces)`);
    expect(r.score).toBeGreaterThanOrEqual(95);
  });

  it('gives drawing only the streets not asked for no recall, but full precision', async () => {
    const m = await mapOf(name);
    const pieces = scoreDrawing(m.roads, [], false, m.named, m.tunnels).roadPieces;
    const r = scoreDrawing(m.roads, linesOf(pieces, (p) => !p.key).map(byHand), false, m.named, m.tunnels);
    console.log(`${name}: non-key only recall ${r.recall.toFixed(2)}, precision ${r.precision.toFixed(2)}`);
    // Not 0: a side lane or alley running 9–26 m beside a key street credits it, as any line that
    // close would (13% of key length in Seogyo-dong), and so does an expressway built over one
    // (Shibuya's Shuto line over Route 246: 0.25 there).
    expect(r.recall).toBeLessThanOrEqual(0.35);
    expect(r.precision).toBeGreaterThanOrEqual(0.95);
  });

  it('never asks for a motorway or ramp', async () => {
    const m = await mapOf(name);
    const motorways = m.roads.filter((x) => x.motorway).map((x) => x.pts);
    const key = scoreDrawing(m.roads, [], false, m.named, m.tunnels).roadPieces.filter((p) => p.key);
    // Both ends on the same motorway: a piece that only meets one at a junction doesn't count.
    expect(key.filter((p) => motorways.some((l) => onLines(p.a, [l], 0.5) && onLines(p.b, [l], 0.5)))).toEqual([]);
  });

  it('lists no street that runs mostly in a tunnel', async () => {
    const m = await mapOf(name);
    for (const s of scoreDrawing(m.roads, [], false, m.named, m.tunnels).streets) {
      const pts = m.named.filter((x) => x.name === s.name).flatMap((x) => x.pts);
      const under = pts.filter((p) => onLines(p, m.tunnels, 1)).length;
      expect(under / pts.length, s.name).toBeLessThan(0.5);
    }
  });

  it('gives drawing any one asked-for street a modest score, with or without printed roads', async () => {
    const m = await mapOf(name);
    for (const hints of [false, true]) {
      // The ten longest; shorter ones can't score more.
      const streets = scoreDrawing(m.roads, [], hints, m.named, m.tunnels).streets.slice(0, 10);
      const scored = streets.map((s) => {
        const lines = m.named.filter((x) => x.name === s.name).map((x) => byHand(x.pts));
        return { name: s.name, r: scoreDrawing(m.roads, lines, hints, m.named, m.tunnels) };
      });
      if (!scored.length) continue;
      const { name: top, r } = scored.reduce((a, b) => (b.r.score > a.r.score ? b : a));
      console.log(`${name}: just ${top}${hints ? ' (roads printed)' : ''} ${r.score}`);
      // One known street is a fair part of the game (Seogyo-dong's 어울마당로 scores 60), but not
      // all of it: Gangnam with the roads printed scored 100 before key streets were topped up.
      expect(r.score).toBeLessThanOrEqual(70);
    }
  });

  it('gives tracing the printed 100 m sheet grid a low score', async () => {
    const m = await mapOf(name);
    const r = scoreDrawing(m.roads, grid(100), false, m.named, m.tunnels);
    console.log(`${name}: 100 m grid ${r.score}`);
    expect(r.score).toBeLessThanOrEqual(40);
  });

  it('gives nothing for tracing the printed main roads', async () => {
    const m = await mapOf(name);
    const major = m.roads.filter((x) => x.cls === 'major').map((x) => x.pts);
    const r = scoreDrawing(m.roads, major, true, m.named, m.tunnels);
    console.log(`${name}: printed roads traced ${r.score}`);
    expect(r.score).toBeLessThanOrEqual(10);
  });
});
