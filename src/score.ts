import { type Pt, dist, distToSegment } from './geo';
import type { Road } from './osm';

/**
 * How far, in metres, a drawn line may sit from a real street and still count as that street.
 * Dense city blocks are 40–80 m across, so much more than this credits the wrong street, and a
 * uniform grid of lines starts to cover every street in a grid-plan district.
 */
export const TOLERANCE = 18;
/** Lines are cut into pieces no longer than this before matching, in metres. */
const STEP = 8;
/**
 * A drawn line only counts for a street running roughly the same way (within 30°). Without it, a
 * line that merely crosses a street earns credit at the crossing, and one straight stroke through a
 * dense grid of alleys collects a little from every alley.
 */
const MIN_ALIGNMENT = Math.cos(Math.PI / 6);
/** A drawn line this close to one already drawn, in metres, going the same way, is a retrace. */
const RETRACE = 12;
/**
 * Hand tremor makes neighbouring pointer samples point every which way, so a drawn line's direction
 * is read over this much of the line on either side, in metres.
 */
const SMOOTHING = 15;

export interface Piece {
  a: Pt;
  b: Pt;
  hit: boolean;
}

export interface NamedStreet {
  name: string;
  length: number;
  recall: number;
}

export interface ScoreResult {
  /** 0–100, the harmonic mean of recall and precision. */
  score: number;
  /** Share of real street length that has a drawn line near it. */
  recall: number;
  /** Share of drawn length that lies on a real street. */
  precision: number;
  /** Real streets that were scored, cut into pieces marked remembered or forgotten. */
  roadPieces: Piece[];
  /** The player's lines in pieces; a miss is an imaginary road. Lines over hint roads are left out. */
  strokePieces: Piece[];
  /** Scored named streets, longest first. */
  streets: NamedStreet[];
}

/**
 * Scores a drawing against the real street network. With `hintsGiven`, the major roads were
 * printed on the sheet, so they are neither rewarded nor counted against the player. `named`
 * carries street names, which the map keeps on separate lines from the network itself.
 */
export function scoreDrawing(roads: Road[], strokes: Pt[][], hintsGiven: boolean, named: Road[] = roads): ScoreResult {
  const targets = hintsGiven ? roads.filter((r) => r.cls === 'minor') : roads;
  const hints = hintsGiven ? roads.filter((r) => r.cls === 'major') : [];
  const drawnPieces = strokes.map((s) => directed(s, SMOOTHING));

  // Tracing a printed road earns nothing, not even for a side street running alongside it.
  const hintIndex = new PieceIndex(TOLERANCE);
  for (const r of hints) hintIndex.add(directed(r.pts, 0));
  const ownStrokes = drawnPieces.map((ps) => ps.filter((p) => !hintIndex.near(p, TOLERANCE)));

  // A street running alongside a printed road can't be drawn without tracing that road, so it is
  // left out of the recall total as well.
  const targetPieces = targets.map((r) => directed(r.pts, 0).filter((p) => !hintIndex.near(p, TOLERANCE)));
  const targetIndex = new PieceIndex(TOLERANCE);
  for (const ps of targetPieces) targetIndex.add(ps);

  // Going over the same line again draws nothing new, so a piece running alongside one already
  // counted is skipped, for precision and for recall alike. Otherwise retracing one known street
  // many times would outweigh any number of imaginary ones, and spare lines drawn either side of
  // a guess would widen the tolerance for free.
  const strokePieces: Piece[] = [];
  const kept: Directed[] = [];
  const counted = new PieceIndex(TOLERANCE);
  let drawn = 0;
  let onStreet = 0;
  for (const stroke of ownStrokes) {
    // A piece only becomes something to retrace once the pen has moved past it; otherwise each
    // piece would cancel the next one along the same line.
    const pending: { p: Directed; at: number }[] = [];
    let along = 0;
    for (const p of stroke) {
      const len = dist(p.a, p.b);
      along += len;
      while (pending.length && along - pending[0]!.at > RETRACE + STEP) counted.add([pending.shift()!.p]);
      const hit = targetIndex.near(p, TOLERANCE);
      strokePieces.push({ a: p.a, b: p.b, hit });
      if (counted.near(p, RETRACE)) continue;
      pending.push({ p, at: along });
      kept.push(p);
      drawn += len;
      if (hit) onStreet += len;
    }
    counted.add(pending.map((x) => x.p));
  }

  const strokeIndex = new PieceIndex(TOLERANCE);
  strokeIndex.add(kept);

  const roadPieces: Piece[] = [];
  let total = 0;
  let remembered = 0;
  for (const p of targetPieces.flat()) {
    const len = dist(p.a, p.b);
    const hit = strokeIndex.near(p, TOLERANCE);
    roadPieces.push({ a: p.a, b: p.b, hit });
    total += len;
    if (hit) remembered += len;
  }

  const byName = new Map<string, { length: number; hit: number }>();
  for (const road of named) {
    if (!road.name || (hintsGiven && road.cls === 'major')) continue;
    const entry = byName.get(road.name) ?? { length: 0, hit: 0 };
    for (const p of directed(road.pts, 0)) {
      const len = dist(p.a, p.b);
      entry.length += len;
      if (strokeIndex.near(p, TOLERANCE)) entry.hit += len;
    }
    byName.set(road.name, entry);
  }

  const recall = total > 0 ? remembered / total : 0;
  const precision = drawn > 0 ? onStreet / drawn : 0;
  const f1 = recall + precision > 0 ? (2 * recall * precision) / (recall + precision) : 0;
  const streets = [...byName]
    .filter(([, e]) => e.length > 0)
    .map(([name, e]) => ({ name, length: e.length, recall: e.hit / e.length }))
    .sort((x, y) => y.length - x.length);

  return { score: Math.round(f1 * 100), recall, precision, roadPieces, strokePieces, streets };
}

/** A short piece of line with the unit direction it is matched by. */
interface Directed {
  a: Pt;
  b: Pt;
  ux: number;
  uy: number;
}

/**
 * Cuts a line into pieces of at most STEP and gives each a direction: its own, or with `smoothing`
 * the chord across that many metres of line on either side.
 */
function directed(pts: Pt[], smoothing: number): Directed[] {
  const ps = pieces(pts);
  const lens = ps.map(([a, b]) => dist(a, b));
  return ps.map(([a, b], k) => {
    let from = a;
    let to = b;
    if (smoothing > 0) {
      let i = k;
      for (let run = 0; i > 0 && run < smoothing; i--) run += lens[i - 1]!;
      let j = k;
      for (let run = 0; j < ps.length - 1 && run < smoothing; j++) run += lens[j + 1]!;
      from = ps[i]![0];
      to = ps[j]![1];
    }
    let dx = to.x - from.x;
    let dy = to.y - from.y;
    if (dx === 0 && dy === 0) {
      dx = b.x - a.x;
      dy = b.y - a.y;
    }
    const len = Math.hypot(dx, dy) || 1;
    return { a, b, ux: dx / len, uy: dy / len };
  });
}

function mid(a: Pt, b: Pt): Pt {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Cuts a polyline into consecutive segments no longer than STEP. */
function pieces(pts: Pt[]): [Pt, Pt][] {
  const out: [Pt, Pt][] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const n = Math.max(1, Math.ceil(dist(a, b) / STEP));
    for (let k = 0; k < n; k++) {
      out.push([
        { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n },
        { x: a.x + ((b.x - a.x) * (k + 1)) / n, y: a.y + ((b.y - a.y) * (k + 1)) / n },
      ]);
    }
  }
  return out;
}

/**
 * Uniform grid over pieces for "is a piece running the same way within r of this one" queries,
 * r ≤ cell size.
 */
class PieceIndex {
  private cells = new Map<string, Directed[]>();
  constructor(private cell: number) {}

  add(ps: Directed[]): void {
    const c = this.cell;
    for (const p of ps) {
      if (p.a.x === p.b.x && p.a.y === p.b.y) continue;
      const x0 = Math.floor(Math.min(p.a.x, p.b.x) / c);
      const x1 = Math.floor(Math.max(p.a.x, p.b.x) / c);
      const y0 = Math.floor(Math.min(p.a.y, p.b.y) / c);
      const y1 = Math.floor(Math.max(p.a.y, p.b.y) / c);
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const key = `${x},${y}`;
          const list = this.cells.get(key);
          if (list) list.push(p);
          else this.cells.set(key, [p]);
        }
      }
    }
  }

  near(q: Directed, r: number): boolean {
    const m = mid(q.a, q.b);
    const cx = Math.floor(m.x / this.cell);
    const cy = Math.floor(m.y / this.cell);
    for (let x = cx - 1; x <= cx + 1; x++) {
      for (let y = cy - 1; y <= cy + 1; y++) {
        for (const p of this.cells.get(`${x},${y}`) ?? []) {
          if (Math.abs(p.ux * q.ux + p.uy * q.uy) >= MIN_ALIGNMENT && distToSegment(m, p.a, p.b) <= r) return true;
        }
      }
    }
    return false;
  }
}

/** `drewAnything` tells a blank page from one whose every line traced a printed road. */
export function verdict(r: ScoreResult, drewAnything: boolean): string {
  if (!drewAnything) return 'A blank page. Bold.';
  if (r.strokePieces.length === 0) return 'You traced the printed roads. The game is everything else.';
  if (r.score >= 80) return 'You could draw this place in your sleep.';
  if (r.recall >= 0.5 && r.precision < 0.5) return 'You remember the streets, and a few that never existed.';
  if (r.precision >= 0.7 && r.recall < 0.4) return 'Everything you drew is real. There is just a lot more of it.';
  if (r.score >= 55) return 'You know the main drags, the alleys not so much.';
  if (r.score >= 30) return 'The broad strokes are there. The streets are negotiable.';
  return 'Your neighbourhood lives mostly in your imagination.';
}
