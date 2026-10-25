import { describe, expect, it } from "vitest";
import {
  assessWarnings,
  computeAerodynamicForces,
  computeCorridorTelemetry,
  computePowerMultiplier,
  computePowerWatts,
  computeWindCorrection,
} from "./telemetry.js";
import { DEFAULT_DRONE_PROFILE, type Corridor, type WindVector } from "../types.js";

describe("computeWindCorrection", () => {
  it("pure headwind: zero crab angle, ground speed = airspeed - windspeed", () => {
    // Course due north (0deg), wind blowing FROM the north (0deg) = headwind.
    const wind: WindVector = { speedMps: 4, fromDeg: 0, sourceBandsMeters: [10] };
    const { crabAngleDeg, groundSpeedMps } = computeWindCorrection(0, wind, 12);
    expect(crabAngleDeg).toBeCloseTo(0, 5);
    expect(groundSpeedMps).toBeCloseTo(8, 5);
  });

  it("pure tailwind: zero crab angle, ground speed = airspeed + windspeed", () => {
    // Course due north (0deg), wind blowing FROM the south (180deg) = tailwind.
    const wind: WindVector = { speedMps: 4, fromDeg: 180, sourceBandsMeters: [10] };
    const { crabAngleDeg, groundSpeedMps } = computeWindCorrection(0, wind, 12);
    expect(crabAngleDeg).toBeCloseTo(0, 5);
    expect(groundSpeedMps).toBeCloseTo(16, 5);
  });

  it("pure right crosswind requires a nonzero crab angle into the wind", () => {
    // Course due north (0deg), wind blowing FROM the east (90deg).
    const wind: WindVector = { speedMps: 4, fromDeg: 90, sourceBandsMeters: [10] };
    const { crabAngleDeg, groundSpeedMps, crosswindMps } = computeWindCorrection(0, wind, 12);
    expect(crabAngleDeg).toBeGreaterThan(0);
    expect(crosswindMps).toBeCloseTo(4, 5);
    // Ground speed should be slightly less than airspeed once crabbed in.
    expect(groundSpeedMps).toBeLessThan(12);
    expect(groundSpeedMps).toBeGreaterThan(11);
  });

  it("a left crosswind produces the mirror-image (negative) crab angle", () => {
    const wind: WindVector = { speedMps: 4, fromDeg: 270, sourceBandsMeters: [10] };
    const { crabAngleDeg } = computeWindCorrection(0, wind, 12);
    expect(crabAngleDeg).toBeLessThan(0);
  });

  it("clamps gracefully when wind speed exceeds airspeed, and flags it as saturated", () => {
    const wind: WindVector = { speedMps: 50, fromDeg: 90, sourceBandsMeters: [10] };
    const { crabAngleDeg, saturated } = computeWindCorrection(0, wind, 12);
    expect(Number.isFinite(crabAngleDeg)).toBe(true);
    expect(Math.abs(crabAngleDeg)).toBeLessThanOrEqual(90);
    expect(saturated).toBe(true);
  });

  it("is not saturated when the crosswind component is within the aircraft's airspeed", () => {
    const wind: WindVector = { speedMps: 4, fromDeg: 90, sourceBandsMeters: [10] };
    const { saturated } = computeWindCorrection(0, wind, 12);
    expect(saturated).toBe(false);
  });
});

describe("assessWarnings", () => {
  it("flags WIND_SATURATION as critical when the wind is saturated, regardless of crab angle", () => {
    const warnings = assessWarnings(90, 15, true, 12, 5);
    expect(warnings).toEqual([
      expect.objectContaining({ code: "WIND_SATURATION", severity: "critical" }),
    ]);
  });

  it("flags AGGRESSIVE_CROSSWIND when crab angle exceeds the comfort threshold but isn't saturated", () => {
    const warnings = assessWarnings(35, 6, false, 12, 5);
    expect(warnings).toEqual([
      expect.objectContaining({ code: "AGGRESSIVE_CROSSWIND", severity: "warning" }),
    ]);
  });

  it("raises no wind warning when the crab angle is within the comfort threshold", () => {
    const warnings = assessWarnings(10, 2, false, 12, 5);
    expect(warnings.some((w) => w.code === "AGGRESSIVE_CROSSWIND" || w.code === "WIND_SATURATION")).toBe(false);
  });

  it("flags BATTERY_INSUFFICIENT as critical at or above 100% drain", () => {
    const warnings = assessWarnings(0, 0, false, 12, 100);
    expect(warnings).toEqual([
      expect.objectContaining({ code: "BATTERY_INSUFFICIENT", severity: "critical" }),
    ]);
  });

  it("flags BATTERY_LOW_RESERVE when drain leaves less than the required reserve", () => {
    const warnings = assessWarnings(0, 0, false, 12, 85);
    expect(warnings).toEqual([
      expect.objectContaining({ code: "BATTERY_LOW_RESERVE", severity: "warning" }),
    ]);
  });

  it("produces no warnings for a comfortable, low-drain flight", () => {
    expect(assessWarnings(5, 1, false, 12, 10)).toEqual([]);
  });
});

describe("computeAerodynamicForces", () => {
  it("is pure headwind when the wind blows from directly ahead of the heading", () => {
    const wind: WindVector = { speedMps: 6, fromDeg: 90, sourceBandsMeters: [10] };
    const { headwindMps, crosswindMps } = computeAerodynamicForces(90, wind);
    expect(headwindMps).toBeCloseTo(6, 5);
    expect(crosswindMps).toBeCloseTo(0, 5);
  });

  it("is pure tailwind (negative headwind) when the wind blows from directly behind", () => {
    const wind: WindVector = { speedMps: 6, fromDeg: 270, sourceBandsMeters: [10] };
    const { headwindMps, crosswindMps } = computeAerodynamicForces(90, wind);
    expect(headwindMps).toBeCloseTo(-6, 5);
    expect(crosswindMps).toBeCloseTo(0, 5);
  });

  it("is pure crosswind when the wind blows from perpendicular to the heading", () => {
    const wind: WindVector = { speedMps: 6, fromDeg: 180, sourceBandsMeters: [10] };
    const { headwindMps, crosswindMps } = computeAerodynamicForces(90, wind);
    expect(headwindMps).toBeCloseTo(0, 5);
    expect(Math.abs(crosswindMps)).toBeCloseTo(6, 5);
  });
});

describe("computePowerMultiplier", () => {
  it("matches the flat empirical formula exactly", () => {
    expect(computePowerMultiplier(0, 0)).toBeCloseTo(1.0, 10);
    expect(computePowerMultiplier(10, 0)).toBeCloseTo(1.2, 10);
    expect(computePowerMultiplier(0, 10)).toBeCloseTo(1.3, 10);
    expect(computePowerMultiplier(-10, 5)).toBeCloseTo(1.0 + 0.02 * 10 + 0.03 * 5, 10);
  });
});

describe("computePowerWatts", () => {
  it("increases with airspeed and with crosswind magnitude", () => {
    const base = computePowerWatts(10, 0, DEFAULT_DRONE_PROFILE);
    const faster = computePowerWatts(15, 0, DEFAULT_DRONE_PROFILE);
    const windier = computePowerWatts(10, 5, DEFAULT_DRONE_PROFILE);
    expect(faster).toBeGreaterThan(base);
    expect(windier).toBeGreaterThan(base);
  });
});

describe("computeCorridorTelemetry", () => {
  const corridor: Corridor = {
    id: "test-corridor",
    name: "Test",
    description: "unit test fixture",
    start: { lat: 37.0, lon: -122.0 },
    end: { lat: 37.01, lon: -122.0 }, // due north, ~1.1km
    altitudeMeters: 60,
  };

  it("a headwind increases battery drain vs a tailwind over the same corridor", () => {
    const headwind: WindVector = { speedMps: 5, fromDeg: 0, sourceBandsMeters: [60] };
    const tailwind: WindVector = { speedMps: 5, fromDeg: 180, sourceBandsMeters: [60] };

    const headResult = computeCorridorTelemetry(corridor, headwind, DEFAULT_DRONE_PROFILE);
    const tailResult = computeCorridorTelemetry(corridor, tailwind, DEFAULT_DRONE_PROFILE);

    expect(headResult.groundSpeedMps).toBeLessThan(tailResult.groundSpeedMps);
    expect(headResult.etaSeconds).toBeGreaterThan(tailResult.etaSeconds);
    expect(headResult.batteryDrainPercent).toBeGreaterThan(tailResult.batteryDrainPercent);
  });

  it("produces a positive distance roughly matching the haversine estimate", () => {
    const wind: WindVector = { speedMps: 0, fromDeg: 0, sourceBandsMeters: [60] };
    const result = computeCorridorTelemetry(corridor, wind, DEFAULT_DRONE_PROFILE);
    expect(result.distanceMeters).toBeGreaterThan(1000);
    expect(result.distanceMeters).toBeLessThan(1200);
  });

  it("derives reservePercent and powerMultiplier consistently from the rest of the result", () => {
    const wind: WindVector = { speedMps: 5, fromDeg: 0, sourceBandsMeters: [60] };
    const result = computeCorridorTelemetry(corridor, wind, DEFAULT_DRONE_PROFILE);
    expect(result.reservePercent).toBeCloseTo(100 - result.batteryDrainPercent, 8);
    expect(result.powerMultiplier).toBeCloseTo(
      1.0 + 0.02 * Math.abs(result.headwindMps) + 0.03 * Math.abs(result.crosswindMps),
      8,
    );
  });

  it("raises no warnings for a short hop in moderate head/tail wind", () => {
    const headwind: WindVector = { speedMps: 5, fromDeg: 0, sourceBandsMeters: [60] };
    const tailwind: WindVector = { speedMps: 5, fromDeg: 180, sourceBandsMeters: [60] };
    expect(computeCorridorTelemetry(corridor, headwind, DEFAULT_DRONE_PROFILE).warnings).toEqual([]);
    expect(computeCorridorTelemetry(corridor, tailwind, DEFAULT_DRONE_PROFILE).warnings).toEqual([]);
  });

  it("surfaces a WIND_SATURATION warning end-to-end when crosswind overwhelms airspeed", () => {
    // Course due north; wind blowing FROM due east, faster than the drone's airspeed.
    const wind: WindVector = { speedMps: 40, fromDeg: 90, sourceBandsMeters: [60] };
    const result = computeCorridorTelemetry(corridor, wind, DEFAULT_DRONE_PROFILE);
    expect(result.warnings.some((w) => w.code === "WIND_SATURATION")).toBe(true);
  });

  it("surfaces a BATTERY_INSUFFICIENT warning end-to-end on a corridor too long for the battery", () => {
    const longCorridor: Corridor = { ...corridor, end: { lat: 37.45, lon: -122.0 } }; // ~50km
    const wind: WindVector = { speedMps: 0, fromDeg: 0, sourceBandsMeters: [60] };
    const result = computeCorridorTelemetry(longCorridor, wind, DEFAULT_DRONE_PROFILE);
    expect(result.batteryDrainPercent).toBeGreaterThan(100);
    expect(result.warnings.some((w) => w.code === "BATTERY_INSUFFICIENT")).toBe(true);
  });
});
