import type { LatLon, WindVector } from "../types.js";

// Altitude bands Open-Meteo exposes wind data for (meters above ground).
const WIND_BANDS = [10, 80, 120, 180] as const;
type WindBand = (typeof WIND_BANDS)[number];

interface OpenMeteoResponse {
  hourly: {
    time: string[];
    [key: string]: string[] | number[];
  };
}

function bandParams(band: WindBand) {
  return { speed: `wind_speed_${band}m`, dir: `wind_direction_${band}m` };
}

function nearestHourIndex(times: string[]): number {
  const now = Date.now();
  let bestIdx = 0;
  let bestDiff = Infinity;
  times.forEach((t, i) => {
    const diff = Math.abs(new Date(t).getTime() - now);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  });
  return bestIdx;
}

/** Shortest-path average of two compass bearings, weighted by `weight` toward b. */
function interpolateBearingDeg(a: number, b: number, weight: number): number {
  const diff = (((b - a + 540) % 360) - 180); // signed shortest difference, (-180, 180]
  return (a + diff * weight + 360) % 360;
}

/**
 * Fetches live wind speed/direction from Open-Meteo (no API key required) at
 * the two altitude bands enclosing the requested altitude, then linearly
 * interpolates between them. Falls back to clamping at the nearest band if
 * the requested altitude is outside Open-Meteo's [10m, 180m] range.
 */
export async function fetchWindVector(
  location: LatLon,
  altitudeMeters: number,
): Promise<WindVector> {
  const clamped = Math.min(Math.max(altitudeMeters, WIND_BANDS[0]), WIND_BANDS[WIND_BANDS.length - 1]);

  let lowerBand: WindBand = WIND_BANDS[0];
  let upperBand: WindBand = WIND_BANDS[WIND_BANDS.length - 1];
  for (let i = 0; i < WIND_BANDS.length - 1; i++) {
    if (clamped >= WIND_BANDS[i] && clamped <= WIND_BANDS[i + 1]) {
      lowerBand = WIND_BANDS[i];
      upperBand = WIND_BANDS[i + 1];
      break;
    }
  }

  const lower = bandParams(lowerBand);
  const upper = bandParams(upperBand);
  const hourlyVars = Array.from(
    new Set([lower.speed, lower.dir, upper.speed, upper.dir]),
  ).join(",");

  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", location.lat.toFixed(4));
  url.searchParams.set("longitude", location.lon.toFixed(4));
  url.searchParams.set("hourly", hourlyVars);
  url.searchParams.set("wind_speed_unit", "ms");
  url.searchParams.set("forecast_days", "1");
  url.searchParams.set("timezone", "auto");

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Open-Meteo request failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as OpenMeteoResponse;

  const idx = nearestHourIndex(data.hourly.time);
  const lowerSpeed = Number(data.hourly[lower.speed][idx]);
  const lowerDir = Number(data.hourly[lower.dir][idx]);
  const upperSpeed = Number(data.hourly[upper.speed][idx]);
  const upperDir = Number(data.hourly[upper.dir][idx]);

  if (lowerBand === upperBand) {
    return { speedMps: lowerSpeed, fromDeg: lowerDir, sourceBandsMeters: [lowerBand] };
  }

  const weight = (clamped - lowerBand) / (upperBand - lowerBand);
  const speedMps = lowerSpeed + (upperSpeed - lowerSpeed) * weight;
  const fromDeg = interpolateBearingDeg(lowerDir, upperDir, weight);

  return { speedMps, fromDeg, sourceBandsMeters: [lowerBand, upperBand] };
}
