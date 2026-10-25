import { Router } from "express";
import { getCorridorById } from "../data/corridors.js";
import { computeCorridorTelemetry } from "../engine/telemetry.js";
import { fetchWindVector } from "../services/windService.js";
import { DEFAULT_DRONE_PROFILE, type Corridor, type DroneProfile, type TelemetryResult, type WindVector } from "../types.js";

export const telemetryRouter = Router();

async function telemetryForCorridor(
  corridor: Corridor,
  profile: DroneProfile,
  windOverride?: WindVector,
): Promise<TelemetryResult> {
  let wind = windOverride;
  if (!wind) {
    const midpoint = {
      lat: (corridor.start.lat + corridor.end.lat) / 2,
      lon: (corridor.start.lon + corridor.end.lon) / 2,
    };
    wind = await fetchWindVector(midpoint, corridor.altitudeMeters);
  }
  return computeCorridorTelemetry(corridor, wind, profile);
}

function isLatLon(v: unknown): v is { lat: number; lon: number } {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as any).lat === "number" &&
    typeof (v as any).lon === "number"
  );
}

function parseWindOverride(v: unknown): WindVector | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const w = v as Record<string, unknown>;
  if (typeof w.speedMps === "number" && typeof w.fromDeg === "number") {
    return { speedMps: w.speedMps, fromDeg: w.fromDeg, sourceBandsMeters: [] };
  }
  return undefined;
}

function parseCustomCorridor(body: unknown): Corridor | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const b = body as Record<string, unknown>;
  if (
    typeof b.id === "string" &&
    typeof b.name === "string" &&
    isLatLon(b.start) &&
    isLatLon(b.end) &&
    typeof b.altitudeMeters === "number"
  ) {
    return {
      id: b.id,
      name: b.name,
      description: typeof b.description === "string" ? b.description : "",
      start: b.start,
      end: b.end,
      altitudeMeters: b.altitudeMeters,
    };
  }
  return undefined;
}

function parseProfileOverrides(query: Record<string, unknown>): DroneProfile {
  const num = (key: string, fallback: number) => {
    const raw = query[key];
    const parsed = typeof raw === "string" ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    airspeedMps: num("airspeed", DEFAULT_DRONE_PROFILE.airspeedMps),
    batteryCapacityWh: num("batteryWh", DEFAULT_DRONE_PROFILE.batteryCapacityWh),
    hoverPowerWatts: num("hoverW", DEFAULT_DRONE_PROFILE.hoverPowerWatts),
    dragCoefficient: num("dragK", DEFAULT_DRONE_PROFILE.dragCoefficient),
    crosswindCoefficient: num("crosswindK", DEFAULT_DRONE_PROFILE.crosswindCoefficient),
  };
}

// Predefined corridor, looked up by id.
telemetryRouter.get("/:corridorId", async (req, res) => {
  const corridor = getCorridorById(req.params.corridorId);
  if (!corridor) {
    res.status(404).json({ error: `Unknown corridor id: ${req.params.corridorId}` });
    return;
  }

  try {
    const profile = parseProfileOverrides(req.query as Record<string, unknown>);
    const result = await telemetryForCorridor(corridor, profile);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: "Failed to fetch live wind data", detail: String(err) });
  }
});

// Arbitrary corridor supplied in the request body — used for corridors the
// user draws on the map client-side, which the server never stores. Accepts
// an optional `wind` override so a simulation can supply a synthetic wind
// scenario instead of whatever's actually blowing right now.
telemetryRouter.post("/custom", async (req, res) => {
  const corridor = parseCustomCorridor(req.body);
  if (!corridor) {
    res.status(400).json({ error: "Expected { id, name, start: {lat,lon}, end: {lat,lon}, altitudeMeters }" });
    return;
  }

  try {
    const profile = parseProfileOverrides(req.query as Record<string, unknown>);
    const windOverride = parseWindOverride((req.body as Record<string, unknown>).wind);
    const result = await telemetryForCorridor(corridor, profile, windOverride);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: "Failed to fetch live wind data", detail: String(err) });
  }
});
