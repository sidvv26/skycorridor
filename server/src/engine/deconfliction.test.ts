import { describe, expect, it } from "vitest";
import { buildDeconflictedRoute, segmentIntersectsGeofence } from "./deconfliction.js";
import type { Geofence, LatLon } from "../types.js";

const start: LatLon = { lat: 37.0, lon: -122.0 };
const end: LatLon = { lat: 37.02, lon: -122.0 }; // due north, ~2.2km

function makeFence(overrides: Partial<Geofence> = {}): Geofence {
  return {
    id: "fence-1",
    label: "Test TFR",
    kind: "tfr",
    center: { lat: 37.01, lon: -122.0 }, // sits right on the straight-line path
    radiusMeters: 150,
    baseAltitudeMeters: 0,
    topAltitudeMeters: 200,
    ...overrides,
  };
}

describe("segmentIntersectsGeofence", () => {
  it("detects a horizontal intersection when the altitude band overlaps", () => {
    const fence = makeFence();
    expect(segmentIntersectsGeofence({ start, end, altitudeMeters: 60 }, fence)).toBe(true);
  });

  it("ignores a horizontally-intersecting path if the altitude is above the fence's ceiling", () => {
    const fence = makeFence({ topAltitudeMeters: 50 });
    expect(segmentIntersectsGeofence({ start, end, altitudeMeters: 60 }, fence)).toBe(false);
  });

  it("ignores a fence nowhere near the path", () => {
    const farFence = makeFence({ center: { lat: 37.2, lon: -122.3 } });
    expect(segmentIntersectsGeofence({ start, end, altitudeMeters: 60 }, farFence)).toBe(false);
  });
});

describe("buildDeconflictedRoute", () => {
  it("returns a single optimal segment when no geofences are active", () => {
    const result = buildDeconflictedRoute(start, end, 60, []);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].safety).toBe("optimal");
    expect(result.segments[0].start).toEqual(start);
    expect(result.segments[0].end).toEqual(end);
    expect(result.intersectedGeofenceIds).toEqual([]);
  });

  it("returns an unaffected optimal segment when the fence doesn't intersect", () => {
    const farFence = makeFence({ center: { lat: 37.2, lon: -122.3 } });
    const result = buildDeconflictedRoute(start, end, 60, [farFence]);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].safety).toBe("optimal");
    expect(result.intersectedGeofenceIds).toEqual([]);
  });

  it("climbs over a fence with a low ceiling instead of detouring laterally", () => {
    const fence = makeFence({ topAltitudeMeters: 80 }); // 80+10=90 clearance, well within climb budget
    const result = buildDeconflictedRoute(start, end, 60, [fence]);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].safety).toBe("detour");
    expect(result.segments[0].altitudeMeters).toBeGreaterThan(60);
    expect(result.segments[0].start).toEqual(start);
    expect(result.segments[0].end).toEqual(end);
    expect(result.intersectedGeofenceIds).toEqual(["fence-1"]);
  });

  it("detours laterally around a fence too tall to reasonably overfly", () => {
    const fence = makeFence({ topAltitudeMeters: 5000 });
    const result = buildDeconflictedRoute(start, end, 60, [fence]);
    expect(result.segments).toHaveLength(2);
    for (const seg of result.segments) {
      expect(seg.safety).toBe("detour");
      expect(seg.altitudeMeters).toBe(60); // altitude unchanged, only the path bends
    }
    // The waypoint between the two segments should not just be the original start/end.
    const waypoint = result.segments[0].end;
    expect(waypoint).not.toEqual(start);
    expect(waypoint).not.toEqual(end);
  });

  it("marks a segment as hazard when it's impossible to fully clear the fence", () => {
    // Start and end both sit inside a huge fence — no lateral detour point can escape it,
    // and the required climb is absurd, so the safety-net pass should catch this.
    const closeStart: LatLon = { lat: 37.0, lon: -122.0 };
    const closeEnd: LatLon = { lat: 37.0009, lon: -122.0 }; // ~100m apart
    const engulfingFence = makeFence({
      center: { lat: 37.00045, lon: -122.0 },
      radiusMeters: 5000,
      topAltitudeMeters: 100000,
    });
    const result = buildDeconflictedRoute(closeStart, closeEnd, 60, [engulfingFence]);
    expect(result.segments.some((s) => s.safety === "hazard")).toBe(true);
  });
});
