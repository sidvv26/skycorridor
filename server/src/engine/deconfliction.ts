import * as turf from "@turf/turf";
import type { DeconflictionResult, Geofence, LatLon, RouteSegment, SegmentSafety } from "../types.js";

// A fixed 40m margin used to sit next to fence radii of 90-150m, so the
// detour waypoint landed only ~30-45% of a radius beyond the fence edge —
// mathematically clear, but at a pitched 3D camera angle on a 400m-tall
// TFR cylinder the gap read as the drone clipping the fence instead of
// going around it. Scaling with the radius keeps the bend unambiguous
// regardless of fence size.
const CLEARANCE_MARGIN_METERS = 120;
const CLEARANCE_MARGIN_RATIO = 0.75;

function clearanceMarginMeters(fence: Geofence): number {
  return Math.max(CLEARANCE_MARGIN_METERS, fence.radiusMeters * CLEARANCE_MARGIN_RATIO);
}
/** Above this required climb, prefer detouring around the fence laterally
 * instead of overflying it — keeps the altitude change "believable" for a
 * small drone rather than climbing arbitrarily high to dodge anything. */
const MAX_REASONABLE_CLIMB_METERS = 120;
const ALTITUDE_CLEARANCE_METERS = 10;

function toPoint(p: LatLon) {
  return turf.point([p.lon, p.lat]);
}

function fenceCircle(fence: Geofence) {
  return turf.circle([fence.center.lon, fence.center.lat], fence.radiusMeters / 1000, {
    units: "kilometers",
    steps: 32,
  });
}

/** True 3D-aware intersection: horizontal circle intersection (Turf) AND altitude-band overlap. */
export function segmentIntersectsGeofence(segment: { start: LatLon; end: LatLon; altitudeMeters: number }, fence: Geofence): boolean {
  const altitudeOverlaps = segment.altitudeMeters >= fence.baseAltitudeMeters && segment.altitudeMeters <= fence.topAltitudeMeters;
  if (!altitudeOverlaps) return false;

  const line = turf.lineString([
    [segment.start.lon, segment.start.lat],
    [segment.end.lon, segment.end.lat],
  ]);
  return turf.booleanIntersects(line, fenceCircle(fence));
}

/** Perpendicular offset waypoint that clears the fence's circle, computed with Turf's bearing/distance. */
function lateralDetourPoint(start: LatLon, end: LatLon, fence: Geofence): LatLon {
  const courseBearing = turf.bearing(toPoint(start), toPoint(end));
  const toCenterBearing = turf.bearing(toPoint(start), toPoint(fence.center));
  // Signed angular offset of the fence center from the course, in (-180, 180].
  const relative = (((toCenterBearing - courseBearing + 540) % 360) - 180);
  const side = relative >= 0 ? -1 : 1; // steer away from whichever side the fence leans toward
  const detourBearing = (courseBearing + side * 90 + 360) % 360;
  const detourDistanceKm = (fence.radiusMeters + clearanceMarginMeters(fence)) / 1000;

  const centerPoint = toPoint(fence.center);
  const detour = turf.destination(centerPoint, detourDistanceKm, detourBearing, { units: "kilometers" });
  const [lon, lat] = detour.geometry.coordinates;
  return { lat, lon };
}

/** Splits one segment into a detour around/over `fence` — laterally if the
 * climb to clear it would be excessive, otherwise a same-path overflight. */
function planDetourAroundFence(
  segment: { start: LatLon; end: LatLon; altitudeMeters: number },
  fence: Geofence,
): RouteSegment[] {
  const requiredAltitude = fence.topAltitudeMeters + ALTITUDE_CLEARANCE_METERS;
  const requiredClimb = requiredAltitude - segment.altitudeMeters;

  if (requiredClimb > 0 && requiredClimb <= MAX_REASONABLE_CLIMB_METERS) {
    return [{ start: segment.start, end: segment.end, altitudeMeters: requiredAltitude, safety: "detour" }];
  }

  const waypoint = lateralDetourPoint(segment.start, segment.end, fence);
  return [
    { start: segment.start, end: waypoint, altitudeMeters: segment.altitudeMeters, safety: "detour" },
    { start: waypoint, end: segment.end, altitudeMeters: segment.altitudeMeters, safety: "detour" },
  ];
}

/**
 * Builds a deconflicted route: starts as one direct "optimal" segment, then
 * for each active geofence that intersects, splits the affected segment(s)
 * into a detour (lateral waypoint or altitude change). If a detour still
 * can't fully clear a fence (e.g. overlapping restricted zones), that
 * segment is downgraded to "hazard" rather than silently left unsafe.
 */
export function buildDeconflictedRoute(start: LatLon, end: LatLon, altitudeMeters: number, geofences: Geofence[]): DeconflictionResult {
  let segments: RouteSegment[] = [{ start, end, altitudeMeters, safety: "optimal" }];
  const intersectedGeofenceIds = new Set<string>();

  for (const fence of geofences) {
    const next: RouteSegment[] = [];
    for (const segment of segments) {
      if (segmentIntersectsGeofence(segment, fence)) {
        intersectedGeofenceIds.add(fence.id);
        next.push(...planDetourAroundFence(segment, fence).map((s) => ({ ...s, safety: "detour" as SegmentSafety })));
      } else {
        next.push(segment);
      }
    }
    segments = next;
  }

  // Final safety pass: anything that still intersects any fence after
  // detouring is a genuine hazard, not just a rerouted-but-safe detour.
  segments = segments.map((segment) => {
    const stillUnsafe = geofences.some((fence) => segmentIntersectsGeofence(segment, fence));
    return stillUnsafe ? { ...segment, safety: "hazard" as SegmentSafety } : segment;
  });

  return { segments, intersectedGeofenceIds: [...intersectedGeofenceIds] };
}
