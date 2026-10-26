import type { DeconflictionResult, Geofence } from "./geofence";
import type { Corridor, LatLon, TelemetryResult } from "./types";

// Empty string in local dev — relative /api/* paths go through vite.config.ts's
// dev-server proxy to localhost:4000, same as always. In production there's
// no such proxy (the built client is static files, served from an entirely
// different host/domain than the API), so a deployed build needs the API's
// real URL baked in at build time via this env var (set in Vercel's project
// settings, not committed — it's a public URL, not a secret, but it's still
// environment-specific config rather than source).
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request to ${url} failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function getCorridors(): Promise<Corridor[]> {
  return getJson("/api/corridors");
}

export function getTelemetry(corridorId: string): Promise<TelemetryResult> {
  return getJson(`/api/telemetry/${corridorId}`);
}

export interface LiveWind {
  speedMps: number;
  fromDeg: number;
}

/** Live wind speed/direction from Open-Meteo at a point and altitude —
 * throws on failure so callers can fall back to a simulated value rather
 * than blocking a flight on a third-party API being unreachable. */
export async function getLiveWind(location: LatLon, altitudeMeters: number): Promise<LiveWind> {
  const res = await fetch(`${API_BASE}/api/wind/custom`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lat: location.lat, lon: location.lon, altitudeMeters }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Wind request failed: ${res.status}`);
  }
  return res.json() as Promise<LiveWind>;
}

export async function getTelemetryForCorridor(
  corridor: Corridor,
  windOverride?: { speedMps: number; fromDeg: number },
): Promise<TelemetryResult> {
  const res = await fetch(`${API_BASE}/api/telemetry/custom`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(windOverride ? { ...corridor, wind: windOverride } : corridor),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Telemetry request failed: ${res.status}`);
  }
  return res.json() as Promise<TelemetryResult>;
}

export async function getDeconflictedRoute(
  start: LatLon,
  end: LatLon,
  altitudeMeters: number,
  geofences: Geofence[],
): Promise<DeconflictionResult> {
  const res = await fetch(`${API_BASE}/api/deconfliction/route`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ start, end, altitudeMeters, geofences }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Deconfliction request failed: ${res.status}`);
  }
  return res.json() as Promise<DeconflictionResult>;
}
