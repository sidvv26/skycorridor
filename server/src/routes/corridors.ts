import { Router } from "express";
import { CORRIDORS, getCorridorById } from "../data/corridors.js";

export const corridorsRouter = Router();

corridorsRouter.get("/", (_req, res) => {
  res.json(CORRIDORS);
});

corridorsRouter.get("/:id", (req, res) => {
  const corridor = getCorridorById(req.params.id);
  if (!corridor) {
    res.status(404).json({ error: `Unknown corridor id: ${req.params.id}` });
    return;
  }
  res.json(corridor);
});
