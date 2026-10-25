import type { Corridor, LatLon } from "./types";

const STORAGE_KEY = "skycorridor:custom-corridors";

export function isCustomCorridor(corridor: Corridor): boolean {
  return corridor.id.startsWith("custom-");
}

export function loadCustomCorridors(): Corridor[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Corridor[]) : [];
  } catch {
    return [];
  }
}

function saveCustomCorridors(corridors: Corridor[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(corridors));
  } catch {
    // localStorage unavailable (private browsing, quota, etc.) — drawn
    // corridors just won't persist across a refresh.
  }
}

export function addCustomCorridor(start: LatLon, end: LatLon, altitudeMeters = 100): Corridor {
  const existing = loadCustomCorridors();
  const corridor: Corridor = {
    id: `custom-${Date.now()}`,
    name: `Custom corridor ${existing.length + 1}`,
    description: "User-drawn corridor",
    start,
    end,
    altitudeMeters,
  };
  saveCustomCorridors([...existing, corridor]);
  return corridor;
}

export function removeCustomCorridor(id: string): Corridor[] {
  const remaining = loadCustomCorridors().filter((c) => c.id !== id);
  saveCustomCorridors(remaining);
  return remaining;
}
