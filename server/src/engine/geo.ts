import type { LatLon } from "../types.js";

const EARTH_RADIUS_METERS = 6_371_000;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

export function normalizeDeg360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Signed angular difference a-b in degrees, normalized to (-180, 180]. */
export function angleDiffDeg(a: number, b: number): number {
  let diff = normalizeDeg360(a - b);
  if (diff > 180) diff -= 360;
  return diff;
}

/** Great-circle distance between two points, in meters (haversine). */
export function haversineDistanceMeters(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return EARTH_RADIUS_METERS * c;
}

/** Initial great-circle bearing from a to b, in degrees [0, 360). */
export function initialBearingDeg(a: LatLon, b: LatLon): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);

  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);

  return normalizeDeg360(toDeg(Math.atan2(y, x)));
}
