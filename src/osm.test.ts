import { describe, expect, it } from 'vitest';
import { type LatLon, clipPolyline, square } from './geo';
import { type RawFeature, areaLabel, collectTile, emptyMap, pickLandmarks, tileLatLon, tilesFor } from './osm';

const center = { lat: 37.55, lon: 126.92 };

describe('clipPolyline', () => {
  it('keeps a line inside the square untouched', () => {
    const pts = [
      { x: -10, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    expect(clipPolyline(pts, square(100))).toEqual([pts]);
  });

  it('cuts a line at the square edge', () => {
    const [piece] = clipPolyline(
      [
        { x: -200, y: 0 },
        { x: 0, y: 0 },
      ],
      square(100),
    );
    expect(piece?.[0]?.x).toBeCloseTo(-100);
  });

  it('splits a line that leaves and comes back', () => {
    const out = clipPolyline(
      [
        { x: -50, y: 0 },
        { x: -50, y: 200 },
        { x: 50, y: 200 },
        { x: 50, y: 0 },
      ],
      square(100),
    );
    expect(out).toHaveLength(2);
  });

  it('drops a line entirely outside', () => {
    expect(
      clipPolyline(
        [
          { x: 200, y: 200 },
          { x: 300, y: 300 },
        ],
        square(100),
      ),
    ).toEqual([]);
  });
});

describe('tiles', () => {
  it('round-trips a point through its tile', () => {
    const [t] = tilesFor({ south: center.lat, west: center.lon, north: center.lat, east: center.lon });
    expect(t).toBeDefined();
    const nw = tileLatLon(t!.x, t!.y, 0, 0);
    const se = tileLatLon(t!.x, t!.y, 1, 1);
    expect(center.lat).toBeLessThanOrEqual(nw.lat);
    expect(center.lat).toBeGreaterThanOrEqual(se.lat);
    expect(center.lon).toBeGreaterThanOrEqual(nw.lon);
    expect(center.lon).toBeLessThanOrEqual(se.lon);
  });

  it('covers a 1 km square with at most four z14 tiles', () => {
    const d = 0.0045;
    const tiles = tilesFor({ south: center.lat - d, west: center.lon - d, north: center.lat + d, east: center.lon + d });
    expect(tiles.length).toBeGreaterThanOrEqual(1);
    expect(tiles.length).toBeLessThanOrEqual(4);
  });
});

describe('antimeridian', () => {
  it('fetches tiles on both sides of 180°', () => {
    const xs = tilesFor({ south: -16.8, west: 179.995, north: -16.79, east: -179.995 }).map((t) => t.x);
    expect(xs).toContain(0);
    expect(xs).toContain(2 ** 14 - 1);
  });
});

describe('collectTile', () => {
  const [tile] = tilesFor({ south: center.lat, west: center.lon, north: center.lat, east: center.lon });
  const empty = emptyMap;
  const across = (dLat: number): LatLon[] => [
    { lat: center.lat + dLat, lon: center.lon - 0.001 },
    { lat: center.lat + dLat, lon: center.lon + 0.001 },
  ];
  const line = (layer: string, props: RawFeature['props'], dLat = 0): RawFeature => ({ layer, props, type: 2, rings: [across(dLat)] });

  it('sorts streets, rail and water and skips tunnels and footways', () => {
    const data = empty();
    collectTile(
      [
        line('transportation', { class: 'primary' }),
        line('transportation', { class: 'minor' }, 0.001),
        line('transportation', { class: 'motorway' }, 0.0012),
        line('transportation', { class: 'primary', ramp: 1 }, 0.0013),
        line('transportation', { class: 'path', subclass: 'pedestrian' }, 0.0015),
        line('transportation', { class: 'path', subclass: 'footway' }, 0.0018),
        line('transportation', { class: 'service' }, 0.002),
        line('transportation', { class: 'minor', brunnel: 'tunnel' }, 0.0025),
        line('transportation', { class: 'rail', subclass: 'rail', brunnel: 'tunnel' }, 0.0026),
        line('transportation', { class: 'rail', subclass: 'rail' }, -0.001),
        line('transportation', { class: 'transit', subclass: 'subway' }, -0.0012),
        line('transportation_name', { class: 'primary', name: 'Big Rd' }),
        line('transportation_name', { class: 'motorway', name: 'Expressway' }, 0.0012),
        line('waterway', { class: 'river' }, -0.002),
        { layer: 'building', props: {}, type: 3, rings: [across(0.003)] },
      ],
      tile!,
      center,
      500,
      data,
    );
    expect(data.roads.map((r) => r.cls)).toEqual(['major', 'minor', 'major', 'major', 'minor']);
    expect(data.rail).toHaveLength(1);
    // A street tunnel is kept apart, to tell its name from the street above; a rail tunnel isn't.
    expect(data.tunnels).toHaveLength(1);
    expect(data.roads.map((r) => r.motorway ?? false)).toEqual([false, false, true, true, false]);
    expect(data.named).toEqual([
      expect.objectContaining({ name: 'Big Rd', cls: 'major' }),
      expect.objectContaining({ name: 'Expressway', cls: 'major', motorway: true }),
    ]);
    expect(data.named[0]).not.toHaveProperty('motorway');
    expect(data.water).toHaveLength(1);
    expect(data.buildings).toHaveLength(1);
    // Motorways and ramps are real streets but not asked for.
    expect(data.roads.map((r) => r.key)).toEqual([true, false, false, false, false]);
  });

  it('takes parks and woods from landcover, not protected areas', () => {
    const data = empty();
    const area = (layer: string, props: RawFeature['props']): RawFeature => ({ layer, props, type: 3, rings: [across(0.001)] });
    collectTile(
      [
        area('landcover', { class: 'grass', subclass: 'park' }),
        area('landcover', { class: 'wood', subclass: 'forest' }),
        area('landcover', { class: 'farmland' }),
        area('park', { class: 'historic' }),
      ],
      tile!,
      center,
      500,
      data,
    );
    expect(data.parks).toHaveLength(1);
    expect(data.woods).toHaveLength(1);
  });

  it('keeps named landmarks of memorable kinds', () => {
    const data = empty();
    const at = (dLat: number) => [[{ lat: center.lat + dLat, lon: center.lon }]];
    collectTile(
      [
        { layer: 'poi', props: { class: 'railway', subclass: 'subway', name: 'Hongik Univ.', rank: 2 }, type: 1, rings: at(0.001) },
        { layer: 'poi', props: { class: 'restaurant', subclass: 'restaurant', name: 'Noodles' }, type: 1, rings: at(0.002) },
        { layer: 'poi', props: { class: 'school', subclass: 'kindergarten', name: 'Tiny' }, type: 1, rings: at(0.003) },
        { layer: 'poi', props: { class: 'park', subclass: 'park' }, type: 1, rings: at(0.004) },
        { layer: 'poi', props: { class: 'hospital', subclass: 'clinic', name: 'Clinic' }, type: 1, rings: at(0.0015) },
        { layer: 'poi', props: { class: 'library', subclass: 'books', name: 'Bookshop' }, type: 1, rings: at(0.0025) },
        { layer: 'mountain_peak', props: { class: 'peak', name: 'Wausan', rank: 1 }, type: 1, rings: at(-0.001) },
        { layer: 'mountain_peak', props: { class: 'cliff', name: 'Cliff' }, type: 1, rings: at(-0.002) },
      ],
      tile!,
      center,
      500,
      data,
    );
    expect(data.landmarks.map((l) => [l.name, l.cls, l.tier, l.rank])).toEqual([
      ['Hongik Univ.', 'railway', 0, 2],
      ['Wausan', 'peak', 1, 1],
    ]);
  });

  it('projects north as positive y', () => {
    const data = empty();
    collectTile([line('transportation', { class: 'minor' }, 0.001)], tile!, center, 500, data);
    expect(data.roads[0]?.pts[0]?.y).toBeCloseTo(111.2, 0);
  });

  it("drops the part of a line in a neighbouring tile's buffer", () => {
    const data = empty();
    const east = tileLatLon(tile!.x, tile!.y, 1, 0.5);
    // Runs from 100 m inside the tile to 100 m beyond its east edge.
    const f: RawFeature = {
      layer: 'transportation',
      props: { class: 'minor' },
      type: 2,
      rings: [
        [
          { lat: east.lat, lon: east.lon - 0.0011 },
          { lat: east.lat, lon: east.lon + 0.0011 },
        ],
      ],
    };
    const c = { lat: east.lat, lon: east.lon };
    collectTile([f], tile!, c, 500, data);
    const xs = data.roads.flatMap((r) => r.pts.map((p) => p.x));
    expect(Math.max(...xs)).toBeCloseTo(0, 0);
  });
});

describe('pickLandmarks', () => {
  const lm = (name: string, cls: string, x: number, y: number, tier = 2, rank = 1) => ({ name, cls, at: { x, y }, tier, rank });

  it('prefers the higher tier, then rank, and keeps labels apart and off the pin', () => {
    const picked = pickLandmarks(
      [
        lm('Library', 'library', 300, 0, 2),
        lm('Station', 'railway', 300, 30, 0),
        lm('Small Uni', 'college', -300, 0, 1, 9),
        lm('Big Uni', 'college', -300, 50, 1, 1),
        lm('Pin Church', 'place_of_worship', 10, 10),
        lm('Station', 'railway', -300, 300, 0),
      ],
      10,
      120,
    );
    expect(picked.map((l) => l.name)).toEqual(['Station', 'Big Uni']);
  });

  it('caps each class at three', () => {
    const parks = [0, 1, 2, 3].map((i) => lm(`Park ${i}`, 'park', -400 + i * 200, 300));
    expect(pickLandmarks(parks, 10, 120)).toHaveLength(3);
  });

  it('keeps a station on the pin but not a second one next to it', () => {
    const picked = pickLandmarks([lm('Koenji', 'railway', 20, 0, 0), lm('Koenji Exit', 'railway', 200, 0, 0, 2)], 10, 120);
    expect(picked.map((l) => l.name)).toEqual(['Koenji']);
  });
});

describe('areaLabel', () => {
  it('uses the district and city, never the street', () => {
    expect(areaLabel({ road: 'Wausan-ro', suburb: 'Seogyo-dong', city: 'Seoul' }, 'x')).toBe('Seogyo-dong, Seoul');
  });

  it('falls back to the display name', () => {
    expect(areaLabel(undefined, 'Shibuya, Tokyo, Japan')).toBe('Shibuya, Tokyo');
  });
});
