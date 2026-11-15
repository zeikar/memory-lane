import { describe, expect, it } from 'vitest';
import type { Pt } from './geo';
import type { Road } from './osm';
import { scoreDrawing } from './score';

const line = (x0: number, y0: number, x1: number, y1: number): Pt[] => [
  { x: x0, y: y0 },
  { x: x1, y: y1 },
];
const road = (pts: Pt[], cls: Road['cls'] = 'minor', name: string | null = null): Road => ({ name, cls, pts });

describe('scoreDrawing', () => {
  const roads = [road(line(-400, 0, 400, 0), 'minor', 'East St'), road(line(0, -400, 0, 400), 'minor', 'North St')];

  it('scores a faithful drawing near 100', () => {
    const r = scoreDrawing(roads, [line(-400, 10, 400, 10), line(-10, -400, -10, 400)], false);
    expect(r.recall).toBeCloseTo(1, 5);
    expect(r.precision).toBeCloseTo(1, 5);
    expect(r.score).toBe(100);
  });

  it('gives half recall for half the streets', () => {
    const r = scoreDrawing(roads, [line(-400, 0, 400, 0)], false);
    // North St gets nothing where the drawing merely crosses it.
    expect(r.recall).toBeCloseTo(0.5, 2);
    expect(r.precision).toBeCloseTo(1, 5);
    expect(r.score).toBe(67);
    expect(r.streets.find((s) => s.name === 'East St')?.recall).toBeCloseTo(1, 5);
    expect(r.streets.find((s) => s.name === 'North St')?.recall).toBeCloseTo(0, 5);
  });

  it('counts a line drawn far from any street as imaginary', () => {
    const r = scoreDrawing(roads, [line(-400, 0, 400, 0), line(-400, 300, 400, 300)], false);
    expect(r.precision).toBeCloseTo(0.5, 2);
    expect(r.strokePieces.some((p) => !p.hit)).toBe(true);
  });

  it('treats a line outside the tolerance as a miss', () => {
    const r = scoreDrawing(roads, [line(-400, 30, 400, 30)], false);
    expect(r.recall).toBeLessThan(0.1);
  });

  it('gives a straight line through a grid of alleys no credit for the alleys it crosses', () => {
    const alleys = Array.from({ length: 20 }, (_, i) => road(line(-400 + i * 40, -400, -400 + i * 40, 400)));
    const r = scoreDrawing(alleys, [line(-400, 0, 400, 0)], false);
    expect(r.recall).toBe(0);
    expect(r.precision).toBe(0);
  });

  it('still matches a wobbly hand-drawn line', () => {
    // Mouse-like jitter: samples 2 m apart, wandering ±3 m off the line.
    const wobbly: Pt[] = Array.from({ length: 401 }, (_, i) => ({ x: -400 + i * 2, y: Math.sin(i * 1.7) * 3 }));
    const r = scoreDrawing(roads, [wobbly], false);
    expect(r.streets.find((s) => s.name === 'East St')?.recall).toBeGreaterThan(0.95);
  });

  it('gives no credit to a street meeting the line at 40°', () => {
    const slant = road(line(0, 0, 400 * Math.cos(0.7), 400 * Math.sin(0.7)), 'minor', 'Slant St');
    const r = scoreDrawing([slant], [line(-400, 0, 400, 0)], false);
    expect(r.recall).toBeLessThan(0.1);
  });

  it('gives a uniform grid of lines little credit on a grid-plan district', () => {
    // Streets every 70 m both ways, like a dense grid-plan neighbourhood.
    const city: Road[] = [];
    for (let v = -490; v <= 490; v += 70) city.push(road(line(-500, v, 500, v)), road(line(v, -500, v, 500)));
    // The player traces a line every 100 m, the printed sheet grid.
    const grid: Pt[][] = [];
    for (let v = -400; v <= 400; v += 100) grid.push(line(-500, v, 500, v), line(v, -500, v, 500));
    expect(scoreDrawing(city, grid, false).score).toBeLessThan(35);
  });

  it('counts a line drawn over and over once', () => {
    const once = scoreDrawing(roads, [line(-400, 0, 400, 0), line(-400, 300, 400, 300)], false);
    const again = scoreDrawing(roads, [...Array.from({ length: 20 }, () => line(-400, 0, 400, 0)), line(-400, 300, 400, 300)], false);
    expect(again.precision).toBeCloseTo(once.precision, 2);
    expect(again.score).toBe(once.score);
  });

  it('weighs a line by its length, however densely the pointer sampled it', () => {
    const sampled = (y: number, step: number): Pt[] =>
      Array.from({ length: Math.round(800 / step) + 1 }, (_, i) => ({ x: -400 + i * step, y }));
    const denseReal = scoreDrawing(roads, [sampled(0, 2.5), sampled(300, 8)], false);
    const sparseReal = scoreDrawing(roads, [sampled(0, 8), sampled(300, 2.5)], false);
    expect(denseReal.precision).toBeCloseTo(0.5, 1);
    expect(sparseReal.precision).toBeCloseTo(0.5, 1);
  });

  it('treats a shaky retrace a few metres off as the same line', () => {
    const shaky = Array.from({ length: 30 }, (_, i) => line(-400, ((i % 5) - 2) * 3, 400, ((i % 5) - 2) * 3));
    const r = scoreDrawing(roads, [...shaky, line(-400, 300, 400, 300)], false);
    expect(r.precision).toBeCloseTo(0.5, 1);
  });

  it('gives spare lines drawn either side of a guess no extra recall', () => {
    // The guess is 25 m off East St; a spare line 11 m closer would land within tolerance.
    const guess = line(-400, 25, 400, 25);
    const plain = scoreDrawing(roads, [guess], false);
    const hedged = scoreDrawing(roads, [guess, line(-400, 14, 400, 14), line(-400, 36, 400, 36)], false);
    expect(hedged.recall).toBeCloseTo(plain.recall, 5);
  });

  it('counts zigzag shading along a street about once', () => {
    // ±5 m legs advancing 4 m each, along East St, plus an equally long imaginary line.
    const zigzag: Pt[] = Array.from({ length: 201 }, (_, i) => ({ x: -400 + i * 4, y: i % 2 ? 5 : -5 }));
    const r = scoreDrawing(roads, [zigzag, line(-400, 300, 400, 300)], false);
    expect(r.precision).toBeLessThan(0.6);
  });

  it('scores 0 for an empty drawing', () => {
    const r = scoreDrawing(roads, [], false);
    expect(r.score).toBe(0);
    expect(r.roadPieces.every((p) => !p.hit)).toBe(true);
  });

  it('leaves printed hint roads out of both recall and precision', () => {
    const withMajor = [...roads, road(line(-400, 200, 400, 200), 'major', 'Big Rd')];
    const r = scoreDrawing(withMajor, [line(-400, 0, 400, 0), line(-400, 200, 400, 200)], true);
    // Tracing Big Rd neither helps nor hurts.
    expect(r.recall).toBeCloseTo(0.5, 2);
    expect(r.precision).toBeCloseTo(1, 5);
    expect(r.streets.map((s) => s.name)).not.toContain('Big Rd');
  });

  it('gives nothing for tracing a printed road, even to a side street beside it', () => {
    const big = road(line(-400, 200, 400, 200), 'major', 'Big Rd');
    const frontage = road(line(-400, 212, 400, 212), 'minor', 'Side St');
    const r = scoreDrawing([...roads, big, frontage], [line(-400, 200, 400, 200)], true);
    expect(r.recall).toBe(0);
    expect(r.strokePieces).toHaveLength(0);
  });

  it('scores major roads when no hints were printed', () => {
    const withMajor = [...roads, road(line(-400, 200, 400, 200), 'major', 'Big Rd')];
    const r = scoreDrawing(withMajor, [line(-400, 200, 400, 200)], false);
    expect(r.recall).toBeCloseTo(1 / 3, 2);
  });
});
