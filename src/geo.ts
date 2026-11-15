export interface LatLon {
  lat: number;
  lon: number;
}

/** A point in metres on a local plane around the play area's centre: x east, y north. */
export interface Pt {
  x: number;
  y: number;
}

/** Half the side of the square play area, in metres. */
export const HALF = 500;

const EARTH_RADIUS = 6371008.8;
const RAD = Math.PI / 180;

/**
 * Equirectangular projection around `center`. Over a 1 km square the distortion is far below
 * what a hand drawing can resolve.
 */
export function makeProjection(center: LatLon): (p: LatLon) => Pt {
  const k = Math.cos(center.lat * RAD);
  return (p) => ({
    // Wrapped, so a play area astride the antimeridian stays in one piece.
    x: ((((p.lon - center.lon + 540) % 360) - 180) * RAD * EARTH_RADIUS * k),
    y: (p.lat - center.lat) * RAD * EARTH_RADIUS,
  });
}

export interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export function bboxAround(center: LatLon, half: number): BBox {
  const dLat = half / EARTH_RADIUS / RAD;
  const dLon = dLat / Math.cos(center.lat * RAD);
  return {
    south: center.lat - dLat,
    west: wrapLon(center.lon - dLon),
    north: center.lat + dLat,
    east: wrapLon(center.lon + dLon),
  };
}

const wrapLon = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const square = (half: number): Rect => ({ minX: -half, minY: -half, maxX: half, maxY: half });

/**
 * Clips a polyline to a rectangle. A line that leaves and re-enters it comes back as several
 * pieces.
 */
export function clipPolyline(pts: Pt[], rect: Rect): Pt[][] {
  const pieces: Pt[][] = [];
  let current: Pt[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const seg = clipSegment(pts[i]!, pts[i + 1]!, rect);
    if (!seg) {
      if (current.length > 1) pieces.push(current);
      current = [];
      continue;
    }
    const [a, b] = seg;
    const last = current[current.length - 1];
    if (last && last.x === a.x && last.y === a.y) {
      current.push(b);
    } else {
      if (current.length > 1) pieces.push(current);
      current = [a, b];
    }
  }
  if (current.length > 1) pieces.push(current);
  return pieces;
}

/** Liang–Barsky. Returns null when the segment misses the rectangle entirely. */
function clipSegment(a: Pt, b: Pt, r: Rect): [Pt, Pt] | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const checks: [number, number][] = [
    [-dx, a.x - r.minX],
    [dx, r.maxX - a.x],
    [-dy, a.y - r.minY],
    [dy, r.maxY - a.y],
  ];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return null;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return null;
      if (t < t1) t1 = t;
    }
  }
  // Keep the original vertices when unclipped, so clipPolyline can chain consecutive segments.
  const start = t0 === 0 ? a : { x: a.x + t0 * dx, y: a.y + t0 * dy };
  const end = t1 === 1 ? b : { x: a.x + t1 * dx, y: a.y + t1 * dy };
  return [start, end];
}
