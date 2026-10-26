import { Router } from "express";
import { getCorridorById } from "../data/corridors.js";
import { fetchWindVector } from "../services/windService.js";

export const windRouter = Router();

// For corridors that don't exist server-side (custom user-drawn ones) — same
// live lookup as the corridor-id route below, just given the point directly
// instead of looking a corridor up by id. Mirrors the
// /api/telemetry/:corridorId vs /api/telemetry/custom split already used
// elsewhere in this API.
windRouter.post("/custom", async (req, res) => {
  const { lat, lon, altitudeMeters } = req.body ?? {};
  if (typeof lat !== "number" || typeof lon !== "number" || typeof altitudeMeters !== "number") {
    res.status(400).json({ error: "Expected numeric lat, lon, and altitudeMeters in the request body" });
    return;
  }

  try {
    const wind = await fetchWindVector({ lat, lon }, altitudeMeters);
    res.json(wind);
  } catch (err) {
    res.status(502).json({ error: "Failed to fetch live wind data", detail: String(err) });
  }
});

windRouter.get("/:corridorId", async (req, res) => {
  const corridor = getCorridorById(req.params.corridorId);
  if (!corridor) {
    res.status(404).json({ error: `Unknown corridor id: ${req.params.corridorId}` });
    return;
  }

  const midpoint = {
    lat: (corridor.start.lat + corridor.end.lat) / 2,
    lon: (corridor.start.lon + corridor.end.lon) / 2,
  };

  try {
    const wind = await fetchWindVector(midpoint, corridor.altitudeMeters);
    res.json(wind);
  } catch (err) {
    res.status(502).json({ error: "Failed to fetch live wind data", detail: String(err) });
  }
});
