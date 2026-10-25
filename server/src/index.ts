import cors from "cors";
import express from "express";
import { corridorsRouter } from "./routes/corridors.js";
import { deconflictionRouter } from "./routes/deconfliction.js";
import { telemetryRouter } from "./routes/telemetry.js";
import { windRouter } from "./routes/wind.js";

const app = express();
const PORT = Number(process.env.PORT) || 4000;

app.use(cors());
app.use(express.json());

app.use("/api/corridors", corridorsRouter);
app.use("/api/wind", windRouter);
app.use("/api/telemetry", telemetryRouter);
app.use("/api/deconfliction", deconflictionRouter);

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`SkyCorridor server listening on http://localhost:${PORT}`);
});
