import type { Corridor } from "../types.js";

// Illustrative point-to-point drone corridors around Tampa, FL, spanning
// altitude bands that line up with Open-Meteo's wind levels (10m / 80m /
// 120m / 180m) so the wind service has real bands to interpolate.
export const CORRIDORS: Corridor[] = [
  {
    id: "tampa-bayshore-davis-islands",
    name: "Bayshore Blvd → Davis Islands",
    description: "Low-altitude harbor crossing, mostly over water.",
    start: { lat: 27.928, lon: -82.472 },
    end: { lat: 27.927, lon: -82.4525 },
    altitudeMeters: 60,
  },
  {
    id: "tampa-ybor-channelside",
    name: "Ybor City → Channelside",
    description: "Urban low-altitude corridor between dense districts — expect obstacles.",
    start: { lat: 27.9605, lon: -82.437 },
    end: { lat: 27.9427, lon: -82.4453 },
    altitudeMeters: 35,
  },
  {
    id: "tampa-lowry-park-traverse",
    name: "Lowry Park Traverse",
    description: "Higher-altitude corridor over open parkland.",
    start: { lat: 27.9847, lon: -82.479 },
    end: { lat: 27.9847, lon: -82.472 },
    altitudeMeters: 150,
  },
  {
    id: "tampa-downtown-skyline-run",
    name: "Downtown Tampa Skyline Run",
    description: "Low-altitude corridor through downtown high-rises — expect obstacles.",
    start: { lat: 27.944, lon: -82.461 },
    end: { lat: 27.954, lon: -82.4545 },
    altitudeMeters: 45,
  },
];

export function getCorridorById(id: string): Corridor | undefined {
  return CORRIDORS.find((c) => c.id === id);
}
