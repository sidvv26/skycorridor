import { bearingDeg, distanceMeters, offsetPoint } from "./geo";
import { hashString, mulberry32 } from "./rng";
import type { LatLon } from "./types";

export interface TrafficDrone {
  id: string;
  callsign: string;
  center: LatLon;
  radiusMeters: number;
  /** degrees/second; sign gives direction (CW/CCW) */
  angularSpeedDegPerSec: number;
  phaseDeg: number;
}

export type TrafficConflictStatus = "clear" | "advisory" | "conflict";

export interface TrafficStatusEntry {
  callsign: string;
  distanceMeters: number;
  bearingDeg: number;
  status: TrafficConflictStatus;
}

export const CONFLICT_RADIUS_METERS = 50;
export const ADVISORY_RADIUS_METERS = 150;

/**
 * Background air traffic — other aircraft sharing the airspace, circling
 * near the corridor independently of the obstacle course. It's here so a
 * "micro-airspace" app actually feels like it's managing traffic in a busy
 * shared sky, not just showing one drone flying through an empty one.
 */
export function generateAmbientTraffic(seedKey: string, center: LatLon, count = 3): TrafficDrone[] {
  const rand = mulberry32(hashString(`${seedKey}-traffic`));
  const drones: TrafficDrone[] = [];
  for (let i = 0; i < count; i++) {
    const bearing = rand() * 360;
    const dist = 70 + rand() * 200;
    const loopCenter = offsetPoint(center, bearing, dist);
    const direction = rand() < 0.5 ? -1 : 1;
    drones.push({
      id: `traffic-${i}`,
      callsign: `AT-${i + 1}`,
      center: loopCenter,
      radiusMeters: 30 + rand() * 60,
      angularSpeedDegPerSec: direction * (12 + rand() * 18),
      phaseDeg: rand() * 360,
    });
  }
  return drones;
}

/** Classifies each traffic drone's current distance from `referencePos` — this
 * is the actual "control" half of air traffic control: knowing what's close. */
export function computeTrafficStatus(
  drones: TrafficDrone[],
  elapsedSeconds: number,
  referencePos: LatLon,
): TrafficStatusEntry[] {
  return drones
    .map((drone) => {
      const pos = trafficDronePosition(drone, elapsedSeconds);
      const dist = distanceMeters(referencePos, pos);
      const status: TrafficConflictStatus =
        dist < CONFLICT_RADIUS_METERS ? "conflict" : dist < ADVISORY_RADIUS_METERS ? "advisory" : "clear";
      return { callsign: drone.callsign, distanceMeters: dist, bearingDeg: bearingDeg(referencePos, pos), status };
    })
    .sort((a, b) => a.distanceMeters - b.distanceMeters);
}

function angleAt(drone: TrafficDrone, elapsedSeconds: number): number {
  return (drone.phaseDeg + drone.angularSpeedDegPerSec * elapsedSeconds + 3600) % 360;
}

export function trafficDronePosition(drone: TrafficDrone, elapsedSeconds: number): LatLon {
  return offsetPoint(drone.center, angleAt(drone, elapsedSeconds), drone.radiusMeters);
}

/** Tangent direction of the circular flight path — which way the nose should face. */
export function trafficDroneHeading(drone: TrafficDrone, elapsedSeconds: number): number {
  const tangentOffset = drone.angularSpeedDegPerSec >= 0 ? 90 : -90;
  return (angleAt(drone, elapsedSeconds) + tangentOffset + 360) % 360;
}
