import { Router } from "express";
import { getCorridorById } from "../data/corridors.js";
import { fetchWindVector } from "../services/windService.js";

export const windRouter = Router();

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
