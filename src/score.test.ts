import { describe, expect, it } from 'vitest';
import type { Pt } from './geo';
import type { Road } from './osm';
import { scoreDrawing } from './score';

const line = (x0: number, y0: number, x1: number, y1: number): Pt[] => [
  { x: x0, y: y0 },
  { x: x1, y: y1 },
];
const road = (pts: Pt[], cls: Road['cls'] = 'minor', name: string | null = null, key = false): Road => ({ name, cls, key, pts });

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

  it('asks only for key streets, and credits an alley drawn as real', () => {
    const alley = road(line(-400, 100, 400, 100), 'minor', '와우산로21길');
    const unnamed = road(line(-400, 150, 400, 150));
    const r = scoreDrawing([...roads, alley, unnamed], [line(-400, 0, 400, 0), line(-400, 100, 400, 100)], false);
    // East St of East St + North St is remembered; the alleys don't enter recall.
    expect(r.recall).toBeCloseTo(0.5, 2);
    // The drawn alley is a real street, not an imaginary one.
    expect(r.precision).toBeCloseTo(1, 5);
    expect(r.streets.map((s) => s.name)).not.toContain('와우산로21길');
    expect(r.roadPieces.some((p) => !p.key)).toBe(true);
  });

  it('counts a through road as key even without a name', () => {
    const tertiary = road(line(-400, 100, 400, 100), 'minor', null, true);
    const r = scoreDrawing([tertiary, road(line(-400, 200, 400, 200))], [line(-400, 100, 400, 100)], false, []);
    expect(r.recall).toBeCloseTo(1, 5);
  });

  it('asks for no street by the name of an underpass', () => {
    // A 600 m name with only its first 200 m over a scored street: the rest is underground.
    const surface = road(line(-300, 100, -100, 100));
    const underpass = road(line(-300, 100, 300, 100), 'minor', 'Underpass');
    const r = scoreDrawing([...roads, surface], [line(-400, 0, 400, 0), line(-10, -400, -10, 400)], false, [...roads, underpass]);
    expect(r.recall).toBeCloseTo(1, 5);
    expect(r.streets.map((s) => s.name)).not.toContain('Underpass');
  });

  it('asks for no street by the name of an underpass running right under it', () => {
    // An unnamed surface street, and 3 m off it the tunnel the name line belongs to.
    const surface = road(line(-300, 100, 300, 100));
    const tunnel = line(-300, 103, 300, 103);
    const underpass = road(tunnel, 'minor', 'Underpass');
    const drawing = [line(-400, 0, 400, 0), line(-10, -400, -10, 400)];
    const r = scoreDrawing([...roads, surface], drawing, false, [...roads, underpass], [tunnel]);
    expect(r.recall).toBeCloseTo(1, 5);
    expect(r.streets.map((s) => s.name)).not.toContain('Underpass');
    // Without the tunnel, the same name line would be the surface street's.
    expect(scoreDrawing([...roads, surface], drawing, false, [...roads, underpass]).recall).toBeLessThan(1);
  });

  it('never asks for a motorway, even beside a key street', () => {
    const motorway: Road = { ...road(line(-400, 100, 400, 100), 'major'), motorway: true };
    const main = road(line(-400, 104, 400, 104), 'minor', 'Main St');
    const r = scoreDrawing([...roads, motorway, main], [], false);
    const onMotorway = r.roadPieces.filter((p) => p.a.y === 100);
    expect(onMotorway.length).toBeGreaterThan(0);
    expect(onMotorway.every((p) => !p.key)).toBe(true);
    expect(r.roadPieces.filter((p) => p.a.y === 104).every((p) => p.key)).toBe(true);
  });

  it('tops up a small share of key streets with the next longest names', () => {
    // 700 m of through road among 4.8 km of numbered side streets: 20% of 5.5 km is 1.1 km, so
    // the longest side street (660 m) is asked for too, and only that one.
    const tertiary = road(line(-350, 450, 350, 450), 'minor', null, true);
    const side = Array.from({ length: 10 }, (_, i) => road(line(-400, -400 + i * 80, -100 + i * 40, -400 + i * 80), 'minor', `가로${i + 1}길`));
    const r = scoreDrawing([tertiary, ...side], [line(-350, 450, 350, 450)], false);
    expect(r.recall).toBeCloseTo(700 / 1360, 2);
    expect(r.streets.map((s) => s.name)).toEqual(['가로10길']);
  });

  it('tops up until no one street is most of what is asked', () => {
    // A St is 800 m of 1150 m key: three 200 m side streets bring the rest up to its length.
    const a = road(line(-400, 0, 400, 0), 'minor', 'A St');
    const b = road(line(-175, 100, 175, 100), 'minor', 'B St');
    const side = Array.from({ length: 5 }, (_, i) => road(line(-100, 200 + i * 50, 100, 200 + i * 50), 'minor', `가로${i + 1}길`));
    const r = scoreDrawing([a, b, ...side], [line(-400, 0, 400, 0)], false);
    expect(r.recall).toBeCloseTo(800 / 1750, 2);
  });

  it('asks only for key streets from exactly 600 m of them', () => {
    const tertiary = road(line(-300, 100, 300, 100), 'minor', null, true);
    const r = scoreDrawing([tertiary, road(line(-400, 200, 400, 200))], [line(-400, 200, 400, 200)], false, []);
    expect(r.recall).toBe(0);
  });

  it('asks for no street by the name of a motorway', () => {
    const expressway = road(line(-400, 100, 400, 100), 'major', 'Expressway');
    const r = scoreDrawing([...roads, expressway], [line(-400, 0, 400, 0), line(-10, -400, -10, 400)], false, [
      ...roads,
      { ...expressway, motorway: true },
    ]);
    expect(r.recall).toBeCloseTo(1, 5);
    expect(r.precision).toBeCloseTo(1, 5);
  });

  it('asks for every street when the key streets are too short to score', () => {
    const stub = road(line(-50, 100, 50, 100), 'minor', null, true);
    const r = scoreDrawing([stub, road(line(-400, 200, 400, 200))], [line(-400, 200, 400, 200)], false, []);
    expect(r.recall).toBeCloseTo(800 / 900, 2);
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

  it('asks for no part of a printed road by name, even its minor stretches', () => {
    const big = road(line(-400, 200, 0, 200), 'major', 'Big Rd');
    const tail = road(line(0, 300, 400, 300), 'minor', 'Big Rd');
    const r = scoreDrawing([...roads, big, tail], [line(-400, 0, 400, 0)], true);
    expect(r.streets.map((s) => s.name)).not.toContain('Big Rd');
    // East St of East St + North St; the tail isn't asked for.
    expect(r.recall).toBeCloseTo(0.5, 2);
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
