import { SAFETY_THRESHOLDS, type Corridor, type DroneProfile, type SafetyWarning, type TelemetryResult, type WindVector } from "../types.js";
import { angleDiffDeg, haversineDistanceMeters, initialBearingDeg } from "./geo.js";

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Wind correction (crab) angle and resulting ground speed, via the standard
 * wind-triangle relation used in aviation:
 *   WCA = asin( (windSpeed / airspeed) * sin(windFromDeg - courseDeg) )
 *   groundSpeed = airspeed * cos(WCA) - windSpeed * cos(windFromDeg - courseDeg)
 * windFromDeg is the meteorological "blowing from" bearing; courseDeg is the
 * desired ground track. WCA is clamped implicitly by clamping asin's input,
 * since a wind faster than the aircraft's airspeed has no exact heading
 * solution for that course.
 */
export function computeWindCorrection(
  courseDeg: number,
  wind: WindVector,
  airspeedMps: number,
) {
  const deltaRad = toRad(angleDiffDeg(wind.fromDeg, courseDeg));
  const rawRatio = (wind.speedMps * Math.sin(deltaRad)) / airspeedMps;
  const ratio = clamp(rawRatio, -1, 1);
  const crabAngleRad = Math.asin(ratio);

  const groundSpeedMps =
    airspeedMps * Math.cos(crabAngleRad) - wind.speedMps * Math.cos(deltaRad);

  const crosswindMps = wind.speedMps * Math.sin(deltaRad);

  return {
    crabAngleDeg: toDeg(crabAngleRad),
    headingDeg: (courseDeg + toDeg(crabAngleRad) + 360) % 360,
    groundSpeedMps: Math.max(groundSpeedMps, 0.1), // avoid div-by-zero on near-standstill
    crosswindMps,
    // |rawRatio| > 1 means no heading holds this course at all: the
    // crosswind component exceeds the aircraft's airspeed.
    saturated: Math.abs(rawRatio) > 1,
  };
}

/**
 * Pilot-facing safety warnings. Two independent risks:
 *  - Wind: fully saturated (crosswind exceeds airspeed) is a hard "cannot
 *    hold this course" case; a large-but-solvable crab angle is a softer
 *    "elevated risk of drifting in gusts" advisory.
 *  - Battery: distinguishes "won't physically arrive" from "arrives with
 *    an unsafe reserve" per SAFETY_THRESHOLDS.
 */
export function assessWarnings(
  crabAngleDeg: number,
  crosswindMps: number,
  saturated: boolean,
  airspeedMps: number,
  batteryDrainPercent: number,
): SafetyWarning[] {
  const warnings: SafetyWarning[] = [];

  if (saturated) {
    warnings.push({
      code: "WIND_SATURATION",
      severity: "critical",
      message: `Crosswind (${Math.abs(crosswindMps).toFixed(1)} m/s) exceeds the drone's airspeed (${airspeedMps.toFixed(1)} m/s) — no heading can hold this course, and the drone will drift outside the corridor.`,
    });
  } else if (Math.abs(crabAngleDeg) > SAFETY_THRESHOLDS.maxComfortableCrabAngleDeg) {
    warnings.push({
      code: "AGGRESSIVE_CROSSWIND",
      severity: "warning",
      message: `Required crab angle of ${crabAngleDeg.toFixed(1)}° exceeds the ${SAFETY_THRESHOLDS.maxComfortableCrabAngleDeg}° comfort limit — elevated risk of drifting outside the corridor in gusty conditions.`,
    });
  }

  if (batteryDrainPercent >= 100) {
    warnings.push({
      code: "BATTERY_INSUFFICIENT",
      severity: "critical",
      message: `Estimated battery drain (${batteryDrainPercent.toFixed(1)}%) exceeds 100% — the drone will not reach the destination on this route.`,
    });
  } else if (batteryDrainPercent > 100 - SAFETY_THRESHOLDS.minReservePercent) {
    warnings.push({
      code: "BATTERY_LOW_RESERVE",
      severity: "warning",
      message: `Estimated battery drain (${batteryDrainPercent.toFixed(1)}%) leaves less than the required ${SAFETY_THRESHOLDS.minReservePercent}% reserve on arrival.`,
    });
  }

  return warnings;
}

/**
 * Heading-relative wind decomposition — the aerodynamic forces the airframe
 * itself feels along its own nose direction, as opposed to the
 * course-relative crosswind `computeWindCorrection` uses internally for the
 * drift/drag battery model. Crabbing cancels ground-track drift, but the
 * airframe still feels a real crosswind relative to its own heading, which
 * is what actually loads the motors — a distinct, real quantity:
 *   headwind  = windSpeed * cos(windFromDeg - headingDeg)
 *   crosswind = windSpeed * sin(windFromDeg - headingDeg)
 */
export function computeAerodynamicForces(headingDeg: number, wind: WindVector) {
  const deltaRad = toRad(angleDiffDeg(wind.fromDeg, headingDeg));
  return {
    headwindMps: wind.speedMps * Math.cos(deltaRad),
    crosswindMps: wind.speedMps * Math.sin(deltaRad),
  };
}

/**
 * Flat empirical "battery consumption multiplier" for dashboard display —
 * simpler than, and independent of, the physically-detailed wattage model
 * below; this is the quick-read headline number shown to pilots.
 */
export function computePowerMultiplier(headwindMps: number, crosswindMps: number): number {
  return 1.0 + 0.02 * Math.abs(headwindMps) + 0.03 * Math.abs(crosswindMps);
}

/**
 * Simplified quadratic-drag power model for a small multirotor:
 * hover baseline + drag scaling with airspeed^2 + an extra penalty for the
 * power spent fighting the crosswind component. Coefficients are
 * illustrative placeholders — tune against real airframe bench data.
 */
export function computePowerWatts(
  airspeedMps: number,
  crosswindMps: number,
  profile: DroneProfile,
): number {
  return (
    profile.hoverPowerWatts +
    profile.dragCoefficient * airspeedMps ** 2 +
    profile.crosswindCoefficient * Math.abs(crosswindMps)
  );
}

export function computeCorridorTelemetry(
  corridor: Corridor,
  wind: WindVector,
  profile: DroneProfile,
): TelemetryResult {
  const distanceMeters = haversineDistanceMeters(corridor.start, corridor.end);
  const courseDeg = initialBearingDeg(corridor.start, corridor.end);

  // `crosswindMps` here is course-relative (drift-facing), used only for the
  // detailed wattage/warnings model below — renamed at destructure to avoid
  // being confused with the heading-relative one computed further down.
  const { crabAngleDeg, headingDeg, groundSpeedMps, crosswindMps: courseCrosswindMps, saturated } =
    computeWindCorrection(courseDeg, wind, profile.airspeedMps);

  const etaSeconds = distanceMeters / groundSpeedMps;
  const powerWatts = computePowerWatts(profile.airspeedMps, courseCrosswindMps, profile);
  const energyWh = powerWatts * (etaSeconds / 3600);
  const batteryDrainPercent = (energyWh / profile.batteryCapacityWh) * 100;
  const reservePercent = Math.max(0, 100 - batteryDrainPercent);

  const { headwindMps, crosswindMps } = computeAerodynamicForces(headingDeg, wind);
  const powerMultiplier = computePowerMultiplier(headwindMps, crosswindMps);

  const warnings = assessWarnings(
    crabAngleDeg,
    courseCrosswindMps,
    saturated,
    profile.airspeedMps,
    batteryDrainPercent,
  );

  return {
    corridorId: corridor.id,
    distanceMeters,
    courseDeg,
    airspeedMps: profile.airspeedMps,
    wind,
    crabAngleDeg,
    headingDeg,
    groundSpeedMps,
    etaSeconds,
    powerWatts,
    batteryDrainPercent,
    headwindMps,
    crosswindMps,
    powerMultiplier,
    reservePercent,
    warnings,
  };
}
