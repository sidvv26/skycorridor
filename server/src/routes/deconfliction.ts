import { Router } from "express";
import { buildDeconflictedRoute } from "../engine/deconfliction.js";
import type { Geofence, LatLon } from "../types.js";

export const deconflictionRouter = Router();

function isLatLon(v: unknown): v is LatLon {
  return typeof v === "object" && v !== null && typeof (v as any).lat === "number" && typeof (v as any).lon === "number";
}

function isGeofence(v: unknown): v is Geofence {
  if (typeof v !== "object" || v === null) return false;
  const g = v as Record<string, unknown>;
  return (
    typeof g.id === "string" &&
    typeof g.label === "string" &&
    (g.kind === "tfr" || g.kind === "emergency" || g.kind === "stadium") &&
    isLatLon(g.center) &&
    typeof g.radiusMeters === "number" &&
    typeof g.baseAltitudeMeters === "number" &&
    typeof g.topAltitudeMeters === "number"
  );
}

// Given a corridor and the set of currently-active geofences (TFRs, emergency
// zones, stadium restrictions), returns a deconflicted route: one or more
// segments, each tagged optimal/detour/hazard, with per-segment altitude.
// Pure geometry — no wind involved; fetch telemetry per returned segment
// separately via POST /api/telemetry/custom, same pattern as obstacle reroutes.
deconflictionRouter.post("/route", (req, res) => {
  const body = req.body as Record<string, unknown>;
  const start = body.start;
  const end = body.end;
  const altitudeMeters = body.altitudeMeters;
  const geofences = body.geofences;

  if (!isLatLon(start) || !isLatLon(end) || typeof altitudeMeters !== "number" || !Array.isArray(geofences) || !geofences.every(isGeofence)) {
    res.status(400).json({
      error: "Expected { start: {lat,lon}, end: {lat,lon}, altitudeMeters: number, geofences: Geofence[] }",
    });
    return;
  }

  const result = buildDeconflictedRoute(start, end, altitudeMeters, geofences);
  res.json(result);
});
