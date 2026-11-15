import { describe, expect, it } from 'vitest';
import type { Pt } from './geo';
import { answerLine, combine, pickQuestions, roundVerdict } from './quiz';
import { type NamedStreet, scoreStreet } from './score';

const line = (x0: number, y0: number, x1: number, y1: number): Pt[] => [
  { x: x0, y: y0 },
  { x: x1, y: y1 },
];

/** A straight street along y = `y` from x0 to x1, cut into 8 m pieces like scoreDrawing's. */
function street(name: string, y: number, x0 = -400, x1 = 400): NamedStreet {
  const pieces = [];
  for (let x = x0; x < x1; x += 8) pieces.push({ a: { x, y }, b: { x: Math.min(x + 8, x1), y } });
  return { name, length: x1 - x0, recall: 0, pieces };
}

describe('pickQuestions', () => {
  const streets = Array.from({ length: 12 }, (_, i) => street(`St ${i}`, i * 50, -400, 400 - i * 20));

  it('asks five of the eight longest, longest first', () => {
    const picked = pickQuestions(streets, () => 0.5);
    expect(picked).toHaveLength(5);
    const longest = new Set(streets.slice(0, 8).map((s) => s.name));
    expect(picked.every((s) => longest.has(s.name))).toBe(true);
    expect(picked.map((s) => s.length)).toEqual([...picked.map((s) => s.length)].sort((a, b) => b - a));
  });

  it('leaves out streets too short to place, measured across, not along both carriageways', () => {
    // 240 m of pieces, but the two carriageways of a 120 m stretch.
    const dual = street('Dual', 100, 0, 120);
    dual.pieces.push(...street('Dual', 120, 0, 120).pieces);
    dual.length = 240;
    expect(pickQuestions([street('Long', 0), street('Stub', 200, 0, 120), dual]).map((s) => s.name)).toEqual(['Long']);
  });

  it('asks every street when there are five or fewer', () => {
    expect(pickQuestions(streets.slice(0, 4))).toHaveLength(4);
  });
});

describe('scoreStreet', () => {
  const asked = street('Main St', 0);

  it('scores a faithful line at 100 and fades past 18 m', () => {
    expect(scoreStreet(asked, [line(-400, 5, 400, 5)]).score).toBe(100);
    const off = scoreStreet(asked, [line(-400, 30, 400, 30)]);
    expect(off.recall).toBeCloseTo(10 / 22, 2);
    expect(scoreStreet(asked, [line(-400, 45, 400, 45)]).score).toBe(0);
  });

  it('counts a line along some other street as imaginary', () => {
    const r = scoreStreet(asked, [line(-400, 0, 400, 0), line(-400, 200, 400, 200)]);
    expect(r.precision).toBeCloseTo(0.5, 2);
  });

  it('counts a line drawn over and over once', () => {
    const r = scoreStreet(asked, Array.from({ length: 10 }, () => line(-400, 0, 0, 0)));
    expect(r.recall).toBeCloseTo(0.5, 1);
    expect(r.precision).toBeCloseTo(1, 2);
  });
});

describe('combine', () => {
  it('averages the scores and weights recall by street length', () => {
    const long = scoreStreet(street('Long', 0), [line(-400, 0, 400, 0)]);
    const short = scoreStreet(street('Short', 200, 0, 200), []);
    const r = combine([long, short]);
    expect(r.score).toBe(50);
    expect(r.recall).toBeCloseTo(800 / 1000, 2);
    // The skipped question drew nothing, so it doesn't pull precision down.
    expect(r.precision).toBeCloseTo(1, 2);
    expect(r.streets.map((s) => s.name)).toEqual(['Long', 'Short']);
  });
});

describe('roundVerdict', () => {
  it('says nothing about alleys, and owns up to a skipped round', () => {
    const asked = street('Main St', 0);
    expect(roundVerdict(combine([scoreStreet(asked, [])]))).toBe('Skipped the lot. Bold.');
    expect(roundVerdict(combine([scoreStreet(asked, [line(-400, 0, 400, 0)])]))).toMatch(/sleep/);
  });
});

describe('answerLine', () => {
  it('tells a skip from a miss', () => {
    const asked = street('Main St', 0);
    expect(answerLine(scoreStreet(asked, []), true)).toBe('Skipped.');
    expect(answerLine(scoreStreet(asked, [line(-400, 200, 400, 200)]), false)).toBe('Not that one.');
    expect(answerLine(scoreStreet(asked, [line(-400, 0, 400, 0)]), false)).toBe('Spot on.');
  });
});
