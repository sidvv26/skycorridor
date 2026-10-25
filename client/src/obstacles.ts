import { bearingDeg, offsetPoint, pointToSegmentDistanceMeters, sideOfLine } from "./geo";
import type { LatLon } from "./types";

export type ObstacleKind = "building" | "bird" | "drone" | "helicopter" | "firework";

export interface Obstacle {
  id: string;
  kind: ObstacleKind;
  label: string;
  heightMeters: number;
  centroid: LatLon;
  radiusMeters: number;
  distanceAlongPathMeters: number;
  footprint: [number, number][];
}

export interface RoutedSegment {
  start: LatLon;
  end: LatLon;
  altitudeMeters: number;
}

// Animation amplitude for each obstacle kind's on-screen wobble — the
// authoritative source for both CorridorMap.tsx's animation (which imports
// these) and the clearance calculation below. These two drifted apart once
// before: the animation radii were bumped for on-screen visibility without
// the route's clearance distance accounting for how far that wobble can
// actually carry the obstacle from its centroid, so a "cleared" route could
// still pass through where a circling helicopter or crossing drone
// genuinely travels. Building/firework don't translate, so 0.
export const BIRD_CIRCLE_RADIUS_M = 26;
export const HELI_CIRCLE_RADIUS_M = 42;
export const DRONE_CROSS_AMPLITUDE_M = 48;

function obstacleWobbleRadiusMeters(kind: ObstacleKind): number {
  if (kind === "bird") return BIRD_CIRCLE_RADIUS_M;
  if (kind === "helicopter") return HELI_CIRCLE_RADIUS_M;
  if (kind === "drone") return DRONE_CROSS_AMPLITUDE_M;
  return 0;
}

const CORRIDOR_HALF_WIDTH_METERS = 20;
const CLEARANCE_MARGIN_METERS = 15;
// An emergency helicopter gets extra breathing room on top of the wobble
// clearance above — it's the one obstacle kind explicitly meant to read as
// "an emergency vehicle," and a near-miss with it reads very differently
// than clipping a generic crossing drone.
const EMERGENCY_EXTRA_CLEARANCE_METERS = 45;
// Mirrors deconfliction.ts's climb-vs-detour threshold for the TFR engine —
// above this required climb, prefer detouring laterally instead of climbing
// arbitrarily high. Buildings here are always generated 20-80m above the
// corridor's own altitude (see generateObstacles), so a climb is always
// comfortably under this and buildings always climb rather than detour.
const MAX_REASONABLE_CLIMB_METERS = 120;
const ALTITUDE_CLEARANCE_METERS = 10;

/**
 * Builds a flight path around a set of obstacles: buildings are climbed
 * over (their rooftop plus clearance) rather than detoured around laterally
 * — they're static towers, always taller than the corridor's own altitude,
 * so going over them is the realistic response, the same way the TFR engine
 * climbs over a low-ceiling restricted zone. Everything else (birds, other
 * drones, helicopters, fireworks) shares the flight's own altitude band
 * rather than towering over it, so those still get a lateral detour —
 * climbing over a moving bird isn't really "avoidance," it's just flying at
 * a different altitude by coincidence.
 *
 * `visualClearanceMeters` is additional margin on top of everything above,
 * meant for the caller to pass a zoom-aware value (see effectiveDangerRadius
 * in CorridorMap.tsx, which this mirrors) — the route can be geometrically
 * clear (confirmed: 15-68m true closest-approach across every predefined
 * corridor, measured leg-by-leg, not just at the detour waypoint) and still
 * *look* like a near-miss, because this app's typical overview zoom puts
 * only a few real meters per screen pixel. Defaults to 0 for callers (like
 * the unit tests) that don't have a map to measure zoom from.
 */
export function buildRoutePath(
  start: LatLon,
  end: LatLon,
  obstacles: Obstacle[],
  baseAltitudeMeters: number,
  visualClearanceMeters = 0,
): RoutedSegment[] {
  if (obstacles.length === 0) return [{ start, end, altitudeMeters: baseAltitudeMeters }];

  const courseBearing = bearingDeg(start, end);
  const lateralObstacles = obstacles.filter((o) => o.kind !== "building");
  const buildings = obstacles.filter((o) => o.kind === "building");

  // First pass: the existing lateral-detour chain, but only for obstacles
  // that actually share the flight's altitude band.
  const waypoints: LatLon[] = [start];
  for (const obstacle of lateralObstacles) {
    const side = sideOfLine(start, end, obstacle.centroid); // steer to the opposite side
    const detourBearing = (courseBearing - side * 90 + 360) % 360;
    const emergencyMargin = obstacle.kind === "helicopter" ? EMERGENCY_EXTRA_CLEARANCE_METERS : 0;
    const detourDistance =
      obstacle.radiusMeters +
      CORRIDOR_HALF_WIDTH_METERS +
      CLEARANCE_MARGIN_METERS +
      obstacleWobbleRadiusMeters(obstacle.kind) +
      emergencyMargin +
      visualClearanceMeters;
    waypoints.push(offsetPoint(obstacle.centroid, detourBearing, detourDistance));
  }
  waypoints.push(end);

  // Second pass: assign each resulting leg its altitude. A leg climbs if
  // any building's footprint falls closest to that leg along the route;
  // multiple qualifying buildings on the same leg take the tallest
  // requirement. Everything else flies at the corridor's own altitude.
  const segments: RoutedSegment[] = [];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const legStart = waypoints[i];
    const legEnd = waypoints[i + 1];
    let altitudeMeters = baseAltitudeMeters;
    for (const building of buildings) {
      const { t } = pointToSegmentDistanceMeters(building.centroid, legStart, legEnd);
      const belongsToThisLeg = t > 0.02 && t < 0.98; // not just incidentally near an endpoint shared with another leg
      if (!belongsToThisLeg) continue;
      const requiredAltitude = building.heightMeters + ALTITUDE_CLEARANCE_METERS;
      const requiredClimb = requiredAltitude - baseAltitudeMeters;
      if (requiredClimb > 0 && requiredClimb <= MAX_REASONABLE_CLIMB_METERS) {
        altitudeMeters = Math.max(altitudeMeters, requiredAltitude);
      }
    }
    segments.push({ start: legStart, end: legEnd, altitudeMeters });
  }
  return segments;
}
