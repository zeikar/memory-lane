import { type Pt, dist, distToSegment } from './geo';
import type { Road } from './osm';

/**
 * How far, in metres, a drawn line may sit from a real street and still count fully as that street.
 * Dense city blocks are 40–80 m across, so much more than this credits the wrong street, and a
 * uniform grid of lines starts to cover every street in a grid-plan district.
 */
export const TOLERANCE = 18;
/**
 * Beyond TOLERANCE, a line still earns part of a key street, fading to nothing at this distance in
 * metres. Placing a street from memory within 18 m is hard: drawing every key street perfectly but
 * 25 m off scored 18, below tracing the printed sheet grid. Alleys get no fade, for recall or
 * precision, since alleys are what a uniform grid of lines lands near; nor does anything when every
 * street is asked for, or a grid would earn the fade on all of them.
 */
const FADE = 40;

/** Share of a street a line this far from it earns: 1 within TOLERANCE, down to 0 at FADE. */
const credit = (d: number) => (d <= TOLERANCE ? 1 : d >= FADE ? 0 : (FADE - d) / (FADE - TOLERANCE));
const strict = (d: number) => (d <= TOLERANCE ? 1 : 0);
/** A piece earning at least this share shows as remembered (or not imaginary) on the reveal. */
const SHOWN_HIT = 0.5;
/** Lines are cut into pieces no longer than this before matching, in metres. */
const STEP = 8;
/**
 * A drawn line only counts for a street running roughly the same way (within 30°). Without it, a
 * line that merely crosses a street earns credit at the crossing, and one straight stroke through a
 * dense grid of alleys collects a little from every alley.
 */
const MIN_ALIGNMENT = Math.cos(Math.PI / 6);
/** How close, in metres, a name's line must run to a street piece to give it that name. */
const NAME_MATCH = 8;
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
  /** Earned at least half its credit. */
  hit: boolean;
}

export interface RoadPiece extends Piece {
  /** Part of a street the score asks you to remember. Other streets only earn credit. */
  key: boolean;
}

export interface NamedStreet {
  name: string;
  length: number;
  recall: number;
}

export interface ScoreResult {
  /** 0–100, the harmonic mean of recall and precision. */
  score: number;
  /** Share of key street length that has a drawn line near it. */
  recall: number;
  /** Share of drawn length that lies on a real street. */
  precision: number;
  /** Real streets that were scored, cut into pieces marked remembered or forgotten. */
  roadPieces: RoadPiece[];
  /** The player's lines in pieces; a miss is an imaginary road. Lines over hint roads are left out. */
  strokePieces: Piece[];
  /** Key named streets, longest first. */
  streets: NamedStreet[];
  /** With `printed` 'alleys', the street pieces that were printed for the player. */
  printed: Piece[];
}

/** What the sheet printed for the player: nothing, the major roads, or every street that isn't key. */
export type Printed = 'none' | 'major' | 'alleys';

/** Numbered side streets in Korean addressing, such as 와우산로21길 or 동교로23가길. */
const SIDE_STREET = /\d+[가-힣]?길$/;
/** A named street this long inside the square, in metres, is one people know by name. */
const KEY_NAME_LENGTH = 300;
/**
 * Below this much street length, in metres, there is too little to ask for: with fewer key streets
 * than this, every street is asked for, and the start screen turns a place down with less.
 */
export const MIN_STREET_LENGTH = 600;
/**
 * Key streets, leaving out the longest key name, should be at least this share of the streets in
 * play, and at least as long as that name. Below it, the next longest names are asked for as well. With the main roads printed in Gangnam,
 * 990 m of 11.6 km was key (the rest is numbered side streets), and drawing that one street scored
 * 100. In Jamsil 53% was key, but 잠실로 was 70% of that and alone scored 82.
 */
const MIN_KEY_SHARE = 0.2;

/**
 * How far each street name runs through the square, in metres. Only the parts lying on the scored
 * network count: name lines have no tunnel flag, so an underpass would otherwise pass as a long
 * street. Motorway and ramp names are left out; nobody draws an interchange from memory.
 */
function nameLengths(named: Road[], onNetwork: (p: Directed) => boolean): Map<string, number> {
  const length = new Map<string, number>();
  for (const r of named) {
    if (!r.name || r.motorway) continue;
    const len = directed(r.pts, 0).reduce((sum, p) => sum + (onNetwork(p) ? dist(p.a, p.b) : 0), 0);
    length.set(r.name, (length.get(r.name) ?? 0) + len);
  }
  return length;
}

/**
 * A street people know by name: one that runs a fair way through the square. Alleys are left out,
 * which in Seoul means the numbered side streets, since there nearly every alley has a name.
 */
const isKeyName = (name: string, length: number) => length >= KEY_NAME_LENGTH && !SIDE_STREET.test(name);

/**
 * Scores a drawing against the real street network. Streets `printed` on the sheet are neither
 * rewarded nor counted against the player. `named` carries street names, which the map keeps on
 * separate lines from the network itself.
 */
export function scoreDrawing(
  roads: Road[],
  strokes: Pt[][],
  printed: Printed,
  named: Road[] = roads,
  tunnels: Pt[][] = [],
): ScoreResult {
  const hintsGiven = printed === 'major';
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

  // Recall asks only for key streets: through roads, plus long named ones. Names live on their own
  // lines in the map, so a piece is a named key street when one of those lines runs along it, and
  // a name piece counts only where it runs along the network (the whole network, printed roads
  // included, so a name's length doesn't depend on the help level). A name line is drawn on its
  // own street's geometry, so one lying closer to a tunnel than to any surface street is the
  // tunnel's, even where a surface street runs right above it.
  const networkIndex = new PieceIndex(TOLERANCE);
  for (const r of roads) networkIndex.add(directed(r.pts, 0));
  const tunnelIndex = new PieceIndex(TOLERANCE);
  for (const t of tunnels) tunnelIndex.add(directed(t, 0));
  const onNetwork = (p: Directed) => {
    const d = networkIndex.nearest(p, NAME_MATCH);
    return d <= NAME_MATCH && d <= tunnelIndex.nearest(p, NAME_MATCH);
  };
  // A printed road's name asks for nothing, not even a minor stretch that shares it.
  const printedNames = new Set(hintsGiven ? named.filter((r) => r.cls === 'major').map((r) => r.name) : []);
  const lengths = [...nameLengths(named, onNetwork)].filter(([n]) => !printedNames.has(n));
  const keyNames = new Set(lengths.filter(([n, len]) => isKeyName(n, len)).map(([n]) => n));
  const isKey = targets.map((r, i) => targetPieces[i]!.map(() => !r.motorway && r.key));
  let keyLength = 0;
  /** Marks the street pieces that lines of the given names run along as key. */
  const askFor = (names: Set<string>) => {
    const index = new PieceIndex(TOLERANCE);
    for (const r of named) if (r.name && names.has(r.name)) index.add(directed(r.pts, 0).filter(onNetwork));
    targetPieces.forEach((ps, i) =>
      ps.forEach((p, k) => {
        if (!targets[i]!.motorway && !isKey[i]![k] && index.near(p, NAME_MATCH)) isKey[i]![k] = true;
      }),
    );
    keyLength = targetPieces.reduce((sum, ps, i) => sum + ps.reduce((s, p, k) => s + (isKey[i]![k] ? dist(p.a, p.b) : 0), 0), 0);
  };
  askFor(keyNames);
  // Too small a share, or one street making up most of it, and that street would be the whole
  // game, so the next longest names are asked for too, numbered side streets included.
  const inPlay = targetPieces.reduce((sum, ps) => sum + ps.reduce((s, p) => s + dist(p.a, p.b), 0), 0);
  const longest = Math.max(0, ...lengths.filter(([n]) => keyNames.has(n)).map(([, len]) => len));
  for (const [name] of lengths.filter(([n]) => !keyNames.has(n)).sort((x, y) => y[1] - x[1])) {
    if (keyLength - longest >= Math.max(MIN_KEY_SHARE * inPlay, longest)) break;
    keyNames.add(name);
    askFor(new Set([name]));
  }
  // With next to no key street, recall would be all or nothing, so every street is asked for.
  const anyKey = keyLength >= MIN_STREET_LENGTH;
  // Printing the side streets leaves the key streets in play, and motorways, which aren't side
  // streets and stay unasked; printed, an expressway would hide the key road beneath it. As with
  // printed major roads, tracing a printed street earns nothing, and a key piece running right
  // alongside one isn't asked for. If that would leave too little to ask for, nothing is printed
  // and the level plays like Landmarks.
  const printedPieces: Piece[] = [];
  if (printed === 'alleys' && anyKey) {
    const side = (i: number, k: number) => !isKey[i]![k] && !targets[i]!.motorway;
    const alleys = new PieceIndex(TOLERANCE);
    targetPieces.forEach((ps, i) => alleys.add(ps.filter((_, k) => side(i, k))));
    const keep = targetPieces.map((ps, i) =>
      ps.map((p, k) => !side(i, k) && !(isKey[i]![k] && alleys.near(p, TOLERANCE))),
    );
    const left = targetPieces.reduce(
      (sum, ps, i) => sum + ps.reduce((s, p, k) => s + (keep[i]![k] && isKey[i]![k] ? dist(p.a, p.b) : 0), 0),
      0,
    );
    if (left >= MIN_STREET_LENGTH) {
      targetPieces.forEach((ps, i) =>
        ps.forEach((p, k) => {
          if (side(i, k)) printedPieces.push({ a: p.a, b: p.b, hit: false });
        }),
      );
      ownStrokes.forEach((ps, j) => (ownStrokes[j] = ps.filter((p) => !alleys.near(p, TOLERANCE))));
      targetPieces.forEach((ps, i) => {
        targetPieces[i] = ps.filter((_, k) => keep[i]![k]);
        isKey[i] = isKey[i]!.filter((_, k) => keep[i]![k]);
      });
    }
  }
  const asked = (i: number, k: number) => !anyKey || isKey[i]![k]!;
  // What's asked for, for the street list: a name line can also run along a piece that is in play
  // but not asked for, such as a motorway above a key piece dropped beside a printed side street.
  const targetIndex = new PieceIndex(TOLERANCE);
  targetPieces.forEach((ps, i) => targetIndex.add(ps.filter((_, k) => asked(i, k))));
  const keyCredit = anyKey ? credit : strict;
  const keyIndex = new PieceIndex(FADE);
  const alleyIndex = new PieceIndex(FADE);
  targetPieces.forEach((ps, i) => {
    keyIndex.add(ps.filter((_, k) => asked(i, k)));
    alleyIndex.add(ps.filter((_, k) => !asked(i, k)));
  });

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
      const c = alleyIndex.near(p, TOLERANCE) ? 1 : keyCredit(keyIndex.nearest(p, FADE));
      strokePieces.push({ a: p.a, b: p.b, hit: c >= SHOWN_HIT });
      if (counted.near(p, RETRACE)) continue;
      pending.push({ p, at: along });
      kept.push(p);
      drawn += len;
      onStreet += len * c;
    }
    counted.add(pending.map((x) => x.p));
  }

  const strokeIndex = new PieceIndex(FADE);
  strokeIndex.add(kept);

  const roadPieces: RoadPiece[] = [];
  let total = 0;
  let remembered = 0;
  targetPieces.forEach((ps, i) =>
    ps.forEach((p, k) => {
      const key = asked(i, k);
      const c = (key ? keyCredit : strict)(strokeIndex.nearest(p, FADE));
      roadPieces.push({ a: p.a, b: p.b, hit: c >= SHOWN_HIT, key });
      if (!key) return;
      const len = dist(p.a, p.b);
      total += len;
      remembered += len * c;
    }),
  );

  const byName = new Map<string, { length: number; hit: number }>();
  for (const road of named) {
    if (!road.name || !keyNames.has(road.name)) continue;
    const entry = byName.get(road.name) ?? { length: 0, hit: 0 };
    // Only the parts that are asked for: on the network and not alongside a printed road.
    for (const p of directed(road.pts, 0).filter((q) => targetIndex.near(q, NAME_MATCH))) {
      const len = dist(p.a, p.b);
      entry.length += len;
      entry.hit += len * keyCredit(strokeIndex.nearest(p, FADE));
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

  return { score: Math.round(f1 * 100), recall, precision, roadPieces, strokePieces, streets, printed: printedPieces };
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
    return this.nearest(q, r, true) <= r;
  }

  /** Distance to the nearest piece running the same way, if within r; otherwise Infinity. */
  nearest(q: Directed, r: number, any = false): number {
    const m = mid(q.a, q.b);
    const cx = Math.floor(m.x / this.cell);
    const cy = Math.floor(m.y / this.cell);
    let best = Infinity;
    for (let x = cx - 1; x <= cx + 1; x++) {
      for (let y = cy - 1; y <= cy + 1; y++) {
        for (const p of this.cells.get(`${x},${y}`) ?? []) {
          if (Math.abs(p.ux * q.ux + p.uy * q.uy) < MIN_ALIGNMENT) continue;
          const d = distToSegment(m, p.a, p.b);
          if (d <= r && d < best) {
            if (any) return d;
            best = d;
          }
        }
      }
    }
    return best;
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
