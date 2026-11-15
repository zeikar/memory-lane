import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { type BBox, type LatLon, type Pt, type Rect, bboxAround, clipPolyline, makeProjection, square } from './geo';

export type RoadClass = 'major' | 'minor';

export interface Road {
  name: string | null;
  cls: RoadClass;
  /**
   * A through road (trunk down to tertiary, not a ramp) that anyone living nearby would know. Only
   * read on the street network; named lines carry false.
   */
  key: boolean;
  /** A motorway or ramp: a real street, but never asked for, by class or by name. Set on both. */
  motorway?: true;
  pts: Pt[];
}

export interface Landmark {
  name: string;
  /** OpenMapTiles POI class, e.g. railway, college, park; `peak` for a mountain top. */
  cls: string;
  at: Pt;
  /** 0 is the most memorable kind. See LANDMARK_TIERS. */
  tier: number;
  /** The tiles' own importance order within a tile, 1 first. */
  rank: number;
}

/** Outer ring first, then any holes. */
export type Polygon = Pt[][];

export interface MapData {
  /** The scored street network. */
  roads: Road[];
  /** Named lines for the same streets, used for labels and the remembered/forgotten lists. */
  named: Road[];
  /** Streets in tunnels. Not scored, but their names are on `named` and must be told apart. */
  tunnels: Pt[][];
  water: Pt[][];
  waterAreas: Polygon[];
  /** Grass of every kind: parks, gardens, lawns. */
  parks: Polygon[];
  woods: Polygon[];
  rail: Pt[][];
  buildings: Polygon[];
  /** Named places that could anchor a memory, best first. See pickLandmarks. */
  landmarks: Landmark[];
}

export const emptyMap = (): MapData => ({
  roads: [],
  named: [],
  tunnels: [],
  water: [],
  waterAreas: [],
  parks: [],
  woods: [],
  rail: [],
  buildings: [],
  landmarks: [],
});

/**
 * The map comes from OpenFreeMap's OpenMapTiles vector tiles: CDN-cached, CORS-open and free,
 * where an Overpass query for the same square can sit in a queue for half a minute. z14 is the
 * deepest level and carries every street and building.
 */
export const ZOOM = 14;
const TILEJSON = 'https://tiles.openfreemap.org/planet';

// Streets people navigate by. Service roads (parking aisles, driveways), footways and paths are
// left out: nobody draws them from memory and they would swamp the score.
const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary']);
const MINOR = new Set(['tertiary', 'minor']);
// Motorways and their ramps are out of key: nobody draws an interchange from memory, and in places
// like Yeouido they were most of the asked-for length. They still count as real streets.
const KEY = new Set(['trunk', 'primary', 'secondary', 'tertiary']);
const RAIL = new Set(['rail', 'light_rail', 'narrow_gauge']);
const WATERWAY = new Set(['river', 'canal', 'stream']);

type Props = Record<string, string | number | boolean>;

/** A decoded tile feature in lon/lat, before projection. */
export interface RawFeature {
  layer: string;
  props: Props;
  /** 1 = point, 2 = line, 3 = polygon, as in the vector tile spec. */
  type: number;
  rings: LatLon[][];
}

export interface Tile {
  x: number;
  y: number;
}

/** Lon/lat of a point given as a fraction (fx, fy) across tile (x, y). */
export function tileLatLon(x: number, y: number, fx: number, fy: number, z = ZOOM): LatLon {
  const n = 2 ** z;
  const lon = ((x + fx) / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + fy)) / n))) * 180) / Math.PI;
  return { lat, lon };
}

function tileOf(p: LatLon, z: number): Tile {
  const n = 2 ** z;
  const rad = (p.lat * Math.PI) / 180;
  return {
    x: Math.floor(((p.lon + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n),
  };
}

export function tilesFor(b: BBox, z = ZOOM): Tile[] {
  const nw = tileOf({ lat: b.north, lon: b.west }, z);
  const se = tileOf({ lat: b.south, lon: b.east }, z);
  const tiles: Tile[] = [];
  const n = 2 ** z;
  // Across the antimeridian the east edge's tile number restarts at 0.
  const east = se.x < nw.x ? se.x + n : se.x;
  for (let x = nw.x; x <= east; x++) for (let y = nw.y; y <= se.y; y++) tiles.push({ x: x % n, y });
  return tiles;
}

function roadClass(props: Props): RoadClass | null {
  const cls = String(props.class ?? '');
  if (MAJOR.has(cls)) return 'major';
  if (MINOR.has(cls) || (cls === 'path' && props.subclass === 'pedestrian')) return 'minor';
  return null;
}

/**
 * Turns one tile's features into play-area geometry. Tiles repeat features in a buffer around
 * their edges, so lines are cut to the tile's own bounds before the play square, or streets near
 * a tile seam would be scored twice.
 */
export function collectTile(features: RawFeature[], tile: Tile, center: LatLon, half: number, data: MapData): void {
  const project = makeProjection(center);
  const nw = project(tileLatLon(tile.x, tile.y, 0, 0));
  const se = project(tileLatLon(tile.x, tile.y, 1, 1));
  const own: Rect = { minX: nw.x, minY: se.y, maxX: se.x, maxY: nw.y };
  const play = square(half);
  const lines = (f: RawFeature) =>
    f.rings.flatMap((ring) => clipPolyline(ring.map(project), own).flatMap((p) => clipPolyline(p, play)));

  for (const f of features) {
    const p = f.props;
    const motorway = p.class === 'motorway' || p.ramp === 1 ? { motorway: true as const } : {};
    if (p.brunnel === 'tunnel') {
      if (f.type === 2 && f.layer === 'transportation' && roadClass(p)) data.tunnels.push(...lines(f));
      continue;
    }
    if (f.type === 2) {
      if (f.layer === 'transportation') {
        const cls = roadClass(p);
        const key = KEY.has(String(p.class ?? '')) && p.ramp !== 1;
        if (cls) for (const pts of lines(f)) data.roads.push({ name: null, cls, key, ...motorway, pts });
        else if (RAIL.has(String(p.subclass ?? ''))) data.rail.push(...lines(f));
      } else if (f.layer === 'transportation_name') {
        const cls = roadClass(p);
        const name = typeof p.name === 'string' && p.name ? p.name : null;
        // This layer has no brunnel, so underpass names get through; score.ts keeps only the parts
        // of a name that lie on the scored network rather than on a tunnel.
        if (cls && name) for (const pts of lines(f)) data.named.push({ name, cls, key: false, ...motorway, pts });
      } else if (f.layer === 'waterway' && WATERWAY.has(String(p.class ?? ''))) {
        data.water.push(...lines(f));
      }
    } else if (f.type === 3) {
      const poly = f.rings.map((ring) => ring.map(project));
      if (f.layer === 'building') data.buildings.push(poly);
      else if (f.layer === 'water') data.waterAreas.push(poly);
      // City parks are grass in `landcover`. The `park` layer is protected areas and historic
      // districts, which can cover a whole old town.
      else if (f.layer === 'landcover' && p.class === 'grass') data.parks.push(poly);
      else if (f.layer === 'landcover' && p.class === 'wood') data.woods.push(poly);
    } else if (f.type === 1 && (f.layer === 'poi' || f.layer === 'mountain_peak') && typeof p.name === 'string' && p.name) {
      // Mountain tops are their own layer, where `class` says peak, volcano, saddle or cliff.
      const peak = f.layer === 'mountain_peak';
      const cls = peak ? 'peak' : String(p.class ?? '');
      const tier = landmarkTier(cls, String((peak ? p.class : p.subclass) ?? ''));
      if (tier === undefined) continue;
      const at = project(f.rings[0]![0]!);
      const inTile = at.x >= own.minX && at.x <= own.maxX && at.y >= own.minY && at.y <= own.maxY;
      const rank = typeof p.rank === 'number' ? p.rank : 99;
      if (inTile && Math.abs(at.x) <= half && Math.abs(at.y) <= half) data.landmarks.push({ name: p.name, cls, at, tier, rank });
    }
  }
}

/**
 * POI kinds worth printing, as OpenMapTiles class/subclass (`*` for any subclass), by tier. The
 * classes alone are too broad: hospital includes clinics, town_hall community centres, library
 * bookshops and college cram schools.
 */
const LANDMARK_TIERS: Record<string, number> = {
  'railway/station': 0,
  'railway/subway': 0,
  'railway/halt': 0,
  'college/university': 1,
  'stadium/*': 1,
  'museum/museum': 1,
  'castle/castle': 1,
  'peak/peak': 1,
  'peak/volcano': 1,
  // Both let through noise: clinics tagged as hospitals, karaoke tagged as an attraction.
  'hospital/hospital': 2,
  'attraction/attraction': 2,
  'town_hall/townhall': 2,
  'park/park': 2,
  'monument/monument': 2,
  'theatre/theatre': 2,
  'library/library': 2,
  'place_of_worship/*': 2,
  'school/school': 3,
  'cinema/cinema': 3,
  'police/police': 3,
  'fire_station/fire_station': 3,
  'post/post_office': 3,
};

function landmarkTier(cls: string, subclass: string): number | undefined {
  return LANDMARK_TIERS[`${cls}/${subclass}`] ?? LANDMARK_TIERS[`${cls}/*`];
}

/** At most this many landmarks of one class, so a block of clinics can't fill the sheet. */
const PER_CLASS = 3;
/** Two stations closer than this, in metres, are one place (Times Square, Times Square–42nd St). */
const STATION_GAP = 250;

/**
 * Picks the landmarks to print: the most memorable kinds first, then the tiles' own rank, each
 * name once, at most PER_CLASS per class, and none within `gap` metres of one already picked.
 * Nothing sits on the pin except a station, which is often what the player searched for.
 */
export function pickLandmarks(all: Landmark[], max: number, gap: number): Landmark[] {
  const picked: Landmark[] = [];
  const names = new Set<string>();
  const perClass = new Map<string, number>();
  for (const l of [...all].sort((a, b) => a.tier - b.tier || a.rank - b.rank)) {
    if (picked.length >= max) break;
    const station = l.cls === 'railway';
    if (names.has(l.name) || (perClass.get(l.cls) ?? 0) >= PER_CLASS) continue;
    if (!station && Math.hypot(l.at.x, l.at.y) < gap / 2) continue;
    const near = (q: Landmark) => Math.hypot(q.at.x - l.at.x, q.at.y - l.at.y);
    if (picked.some((q) => near(q) < (station && q.cls === 'railway' ? STATION_GAP : gap))) continue;
    picked.push(l);
    names.add(l.name);
    perClass.set(l.cls, (perClass.get(l.cls) ?? 0) + 1);
  }
  return picked;
}

const LAYERS = ['transportation', 'transportation_name', 'waterway', 'water', 'landcover', 'building', 'poi', 'mountain_peak'];

function decodeTile(buf: ArrayBuffer, tile: Tile): RawFeature[] {
  const vt = new VectorTile(new PbfReader(buf));
  const out: RawFeature[] = [];
  for (const name of LAYERS) {
    const layer = vt.layers[name];
    if (!layer) continue;
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      const e = f.extent;
      out.push({
        layer: name,
        props: f.properties,
        type: f.type,
        rings: f.loadGeometry().map((ring) => ring.map((pt) => tileLatLon(tile.x, tile.y, pt.x / e, pt.y / e))),
      });
    }
  }
  return out;
}

let tileUrl: Promise<string> | null = null;

/** The tile URL template names the current planet build, so read it from the TileJSON. */
function tileTemplate(): Promise<string> {
  tileUrl ??= fetch(TILEJSON)
    .then((res) => {
      if (!res.ok) throw new Error(`map index returned ${res.status}`);
      return res.json() as Promise<{ tiles?: string[] }>;
    })
    .then((j) => {
      const t = j.tiles?.[0];
      if (!t) throw new Error('map index lists no tiles');
      return t;
    })
    .catch((err: unknown) => {
      tileUrl = null;
      throw err;
    });
  return tileUrl;
}

export async function fetchMap(center: LatLon, half: number): Promise<MapData> {
  const template = await tileTemplate();
  const tiles = tilesFor(bboxAround(center, half));
  const bufs = await Promise.all(
    tiles.map(async (t) => {
      const url = template.replace('{z}', String(ZOOM)).replace('{x}', String(t.x)).replace('{y}', String(t.y));
      const res = await fetch(url);
      if (!res.ok) throw new Error(`map tile returned ${res.status}`);
      return res.arrayBuffer();
    }),
  );
  const data = emptyMap();
  tiles.forEach((t, i) => collectTile(decodeTile(bufs[i]!, t), t, center, half, data));
  data.landmarks = pickLandmarks(data.landmarks, 12, 120);
  return data;
}

export interface Place {
  center: LatLon;
  /** Neighbourhood-level name for the header and share card. Never a street address. */
  label: string;
  /** Longer name to tell search results apart. */
  detail: string;
}

interface NominatimResult {
  lat: string;
  lon: string;
  display_name: string;
  address?: Record<string, string>;
}

const NOMINATIM = 'https://nominatim.openstreetmap.org';

export function areaLabel(address: Record<string, string> | undefined, fallback: string): string {
  if (!address) return fallback.split(',').slice(0, 2).join(',').trim();
  const local =
    address.suburb ?? address.city_district ?? address.borough ?? address.quarter ?? address.neighbourhood ?? address.town ?? address.village;
  const city = address.city ?? address.town ?? address.province ?? address.state ?? address.country;
  const parts = [local, city].filter((p, i, all): p is string => !!p && all.indexOf(p) === i);
  return parts.length ? parts.join(', ') : fallback.split(',')[0]!.trim();
}

function toPlace(r: NominatimResult): Place {
  return {
    center: { lat: Number(r.lat), lon: Number(r.lon) },
    label: areaLabel(r.address, r.display_name),
    detail: r.display_name,
  };
}

export async function searchPlaces(query: string): Promise<Place[]> {
  const url = `${NOMINATIM}/search?format=jsonv2&addressdetails=1&limit=5&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { 'Accept-Language': navigator.language || 'en' } });
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  return ((await res.json()) as NominatimResult[]).map(toPlace);
}

export async function reversePlace(center: LatLon): Promise<Place> {
  const url = `${NOMINATIM}/reverse?format=jsonv2&addressdetails=1&zoom=14&lat=${center.lat}&lon=${center.lon}`;
  try {
    const res = await fetch(url, { headers: { 'Accept-Language': navigator.language || 'en' } });
    if (!res.ok) throw new Error(`Reverse lookup failed (${res.status})`);
    const r = (await res.json()) as NominatimResult;
    return { center, label: areaLabel(r.address, r.display_name), detail: r.display_name };
  } catch {
    // The name is cosmetic; the game works without it.
    return { center, label: 'Your neighbourhood', detail: '' };
  }
}
