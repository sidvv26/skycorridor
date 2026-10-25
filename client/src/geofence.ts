import { distanceMeters } from "./geo";
import type { LatLon } from "./types";

export type GeofenceKind = "tfr" | "emergency" | "stadium";
export type SegmentSafety = "optimal" | "detour" | "hazard";

export interface Geofence {
  id: string;
  label: string;
  kind: GeofenceKind;
  center: LatLon;
  radiusMeters: number;
  baseAltitudeMeters: number;
  topAltitudeMeters: number;
}

export interface RouteSegment {
  start: LatLon;
  end: LatLon;
  altitudeMeters: number;
  safety: SegmentSafety;
}

export interface DeconflictionResult {
  segments: RouteSegment[];
  intersectedGeofenceIds: string[];
}

// Beyond the fence's own radius, how much further the client's lateral
// detour waypoint needs room to push outward — if the fence crowds a
// corridor endpoint (which can't move, unlike a detour waypoint) closer
// than this, the segment connecting to that fixed endpoint can clip the
// fence no matter how the detour is shaped. Confirmed live: without this,
// a route could read as genuinely overlapping the restricted zone on
// screen (up to -21px) with no client-side fix able to correct it, because
// one end of the affected segment was anchored at the fixed start/end
// point itself.
const ENDPOINT_CLEARANCE_BUFFER_METERS = 150;

/**
 * Spawns a single emergency TFR roughly across the middle of the corridor's
 * path. Always tall (400m ceiling) so avoidance reads as a lateral detour —
 * an unmistakable "restricted column of airspace," not a quick hop over.
 */
export function spawnEmergencyTFR(start: LatLon, end: LatLon): Geofence {
  const radiusMeters = 90 + Math.random() * 60;
  const totalDistance = distanceMeters(start, end);
  const clearanceRatio = Math.min(0.48, (radiusMeters + ENDPOINT_CLEARANCE_BUFFER_METERS) / totalDistance);
  const minT = clearanceRatio;
  const maxT = 1 - clearanceRatio;
  const t = minT < maxT ? minT + Math.random() * (maxT - minT) : 0.5; // degenerate (extremely short corridor): best available is the midpoint
  const center: LatLon = {
    lat: start.lat + (end.lat - start.lat) * t,
    lon: start.lon + (end.lon - start.lon) * t,
  };
  return {
    id: `tfr-${Date.now()}`,
    label: "Emergency TFR",
    kind: "tfr",
    center,
    radiusMeters,
    baseAltitudeMeters: 0,
    topAltitudeMeters: 400,
  };
}
