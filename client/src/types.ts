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
  speedMps: number;
  fromDeg: number;
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
  headwindMps: number;
  crosswindMps: number;
  powerMultiplier: number;
  reservePercent: number;
  warnings: SafetyWarning[];
}
