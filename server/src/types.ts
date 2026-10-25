export interface LatLon {
  lat: number;
  lon: number;
}

export interface Corridor {
  id: string;
  name: string;
  description: string;
  start: LatLon;
  end: LatLon;
  altitudeMeters: number;
}

export interface WindVector {
  /** meters per second */
  speedMps: number;
  /** meteorological convention: degrees clockwise from true north, direction the wind blows FROM */
  fromDeg: number;
  /** altitude band(s) the reading was interpolated from, for transparency */
  sourceBandsMeters: number[];
}

export type WarningCode =
  | "WIND_SATURATION"
  | "AGGRESSIVE_CROSSWIND"
  | "BATTERY_INSUFFICIENT"
  | "BATTERY_LOW_RESERVE";

export interface SafetyWarning {
  code: WarningCode;
  severity: "critical" | "warning";
  message: string;
}

export interface TelemetryResult {
  corridorId: string;
  distanceMeters: number;
  courseDeg: number;
  airspeedMps: number;
  wind: WindVector;
  crabAngleDeg: number;
  headingDeg: number;
  groundSpeedMps: number;
  etaSeconds: number;
  powerWatts: number;
  batteryDrainPercent: number;
  /** Heading-relative aerodynamic decomposition (not course-relative) — the
   *  forces the airframe itself feels along its own nose direction. */
  headwindMps: number;
  crosswindMps: number;
  /** Flat empirical "battery consumption multiplier" for dashboard display:
   *  1.0 + 0.02*|headwind| + 0.03*|crosswind|. Simpler than, and separate
   *  from, the physically-detailed wattage model behind `powerWatts`. */
  powerMultiplier: number;
  /** 100 - batteryDrainPercent, floored at 0 — remaining reserve on arrival. */
  reservePercent: number;
  warnings: SafetyWarning[];
}

export type GeofenceKind = "tfr" | "emergency" | "stadium";

/** A cylindrical restricted-airspace zone: a circular footprint extruded
 * between two altitudes. Rendered as a 3D cylinder client-side; intersected
 * against flight paths server-side via Turf.js. */
export interface Geofence {
  id: string;
  label: string;
  kind: GeofenceKind;
  center: LatLon;
  radiusMeters: number;
  baseAltitudeMeters: number;
  topAltitudeMeters: number;
}

export type SegmentSafety = "optimal" | "detour" | "hazard";

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

export interface DroneProfile {
  /** cruise true airspeed, m/s */
  airspeedMps: number;
  /** usable battery capacity, watt-hours */
  batteryCapacityWh: number;
  /** hover/baseline power draw, watts */
  hoverPowerWatts: number;
  /** drag coefficient: watts per (m/s)^2 of airspeed */
  dragCoefficient: number;
  /** extra watts per m/s of crosswind component the drone must fight */
  crosswindCoefficient: number;
}

export const DEFAULT_DRONE_PROFILE: DroneProfile = {
  airspeedMps: 12,
  batteryCapacityWh: 90,
  hoverPowerWatts: 150,
  dragCoefficient: 0.5,
  crosswindCoefficient: 3,
};

export const SAFETY_THRESHOLDS = {
  /** Beyond this crab angle, gust-induced overshoot puts the drone at
   *  meaningfully higher risk of drifting outside the corridor even though
   *  the idealized wind-triangle math says it can hold the line exactly. */
  maxComfortableCrabAngleDeg: 30,
  /** Minimum battery percentage that must remain after reaching the
   *  destination — no margin for a diversion, headwind change, or RTH. */
  minReservePercent: 20,
};
