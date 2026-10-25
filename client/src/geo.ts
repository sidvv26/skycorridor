import type { LatLon } from "./types";

const METERS_PER_DEG_LAT = 111_320;
export const metersPerDegLon = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);

/** Real-world meters represented by one screen pixel at a given latitude and
 * MapLibre/Mapbox-style web-Mercator zoom level (standard 256px tile size). */
export function metersPerPixel(lat: number, zoom: number): number {
  return (156_543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
}

export function toLocalMeters(origin: LatLon, p: LatLon): { x: number; y: number } {
  return {
    x: (p.lon - origin.lon) * metersPerDegLon(origin.lat),
    y: (p.lat - origin.lat) * METERS_PER_DEG_LAT,
  };
}

export function fromLocalMeters(origin: LatLon, x: number, y: number): LatLon {
  return {
    lon: origin.lon + x / metersPerDegLon(origin.lat),
    lat: origin.lat + y / METERS_PER_DEG_LAT,
  };
}

export function distanceMeters(a: LatLon, b: LatLon): number {
  const p = toLocalMeters(a, b);
  return Math.hypot(p.x, p.y);
}

/** Compass bearing (0=N, clockwise) from a to b. */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const p = toLocalMeters(a, b);
  return (((Math.atan2(p.x, p.y) * 180) / Math.PI) + 360) % 360;
}

export function lerpLatLon(a: LatLon, b: LatLon, t: number): LatLon {
  return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
}

/** Eases a compass bearing toward `target` by fraction `t`, via the shortest turn direction. */
export function lerpAngleDeg(current: number, target: number, t: number): number {
  const diff = (((target - current + 540) % 360) - 180);
  return (current + diff * t + 360) % 360;
}

/**
 * Perpendicular distance (meters) from `point` to the segment [segA, segB],
 * plus how far along the segment (0-1) the closest approach falls.
 */
export function pointToSegmentDistanceMeters(
  point: LatLon,
  segA: LatLon,
  segB: LatLon,
): { distanceMeters: number; t: number } {
  const a = toLocalMeters(segA, segA);
  const b = toLocalMeters(segA, segB);
  const p = toLocalMeters(segA, point);
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby || 1;
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * abx;
  const cy = a.y + t * aby;
  return { distanceMeters: Math.hypot(p.x - cx, p.y - cy), t };
}

/** +1 if `point` is to the right of the direction segA->segB, -1 if left. */
export function sideOfLine(segA: LatLon, segB: LatLon, point: LatLon): 1 | -1 {
  const a = toLocalMeters(segA, segA);
  const b = toLocalMeters(segA, segB);
  const p = toLocalMeters(segA, point);
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  return cross >= 0 ? -1 : 1;
}

/** A point `distanceMeters` away from `base` at compass bearing `bearingDegVal`. */
export function offsetPoint(base: LatLon, bearingDegVal: number, distanceMeters: number): LatLon {
  const rad = (bearingDegVal * Math.PI) / 180;
  return fromLocalMeters(base, Math.sin(rad) * distanceMeters, Math.cos(rad) * distanceMeters);
}

export function centroidOfRing(ring: [number, number][]): LatLon {
  let sumLon = 0;
  let sumLat = 0;
  for (const [lon, lat] of ring) {
    sumLon += lon;
    sumLat += lat;
  }
  return { lon: sumLon / ring.length, lat: sumLat / ring.length };
}

export function maxDistanceFromPoint(ring: [number, number][], center: LatLon): number {
  let max = 0;
  for (const [lon, lat] of ring) {
    max = Math.max(max, distanceMeters(center, { lat, lon }));
  }
  return max;
}

export function buildCirclePolygon(center: LatLon, radiusMeters: number, sides = 10): [number, number][] {
  const coords: [number, number][] = [];
  for (let i = 0; i <= sides; i++) {
    const p = offsetPoint(center, (i / sides) * 360, radiusMeters);
    coords.push([p.lon, p.lat]);
  }
  return coords;
}
