import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { type BBox, type LatLon, type Pt, type Rect, bboxAround, clipPolyline, makeProjection, square } from './geo';

export type RoadClass = 'major' | 'minor';

export interface Road {
  name: string | null;
  cls: RoadClass;
  pts: Pt[];
}

/** Outer ring first, then any holes. */
export type Polygon = Pt[][];

export interface MapData {
  /** The scored street network. */
  roads: Road[];
  /** Named lines for the same streets, used for labels and the remembered/forgotten lists. */
  named: Road[];
  water: Pt[][];
  waterAreas: Polygon[];
  rail: Pt[][];
  buildings: Polygon[];
}

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
const RAIL = new Set(['rail', 'light_rail', 'narrow_gauge']);
const WATERWAY = new Set(['river', 'canal', 'stream']);

type Props = Record<string, string | number | boolean>;

/** A decoded tile feature in lon/lat, before projection. */
export interface RawFeature {
  layer: string;
  props: Props;
  /** 2 = line, 3 = polygon, as in the vector tile spec. */
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
    if (p.brunnel === 'tunnel') continue;
    if (f.type === 2) {
      if (f.layer === 'transportation') {
        const cls = roadClass(p);
        if (cls) for (const pts of lines(f)) data.roads.push({ name: null, cls, pts });
        else if (RAIL.has(String(p.subclass ?? ''))) data.rail.push(...lines(f));
      } else if (f.layer === 'transportation_name') {
        const cls = roadClass(p);
        const name = typeof p.name === 'string' && p.name ? p.name : null;
        if (cls && name) for (const pts of lines(f)) data.named.push({ name, cls, pts });
      } else if (f.layer === 'waterway' && WATERWAY.has(String(p.class ?? ''))) {
        data.water.push(...lines(f));
      }
    } else if (f.type === 3) {
      const poly = f.rings.map((ring) => ring.map(project));
      if (f.layer === 'building') data.buildings.push(poly);
      else if (f.layer === 'water') data.waterAreas.push(poly);
    }
  }
}

const LAYERS = ['transportation', 'transportation_name', 'waterway', 'water', 'building'];

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
  const data: MapData = { roads: [], named: [], water: [], waterAreas: [], rail: [], buildings: [] };
  tiles.forEach((t, i) => collectTile(decodeTile(bufs[i]!, t), t, center, half, data));
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
