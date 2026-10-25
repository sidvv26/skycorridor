import { bearingDeg, buildCirclePolygon, distanceMeters, offsetPoint } from "./geo";
import { BIRD_CIRCLE_RADIUS_M, DRONE_CROSS_AMPLITUDE_M, HELI_CIRCLE_RADIUS_M, type Obstacle, type ObstacleKind } from "./obstacles";
import { hashString, mulberry32 } from "./rng";
import type { LatLon } from "./types";

// Fixed buffer (on top of the obstacle's own footprint and, for kinds that
// move, its animated wobble) that no obstacle is ever allowed to encroach
// into around either endpoint — so nothing renders on top of, or swings
// through, the start/end pins regardless of corridor length or which kind
// lands near an end of the sequence.
const ENDPOINT_CLEARANCE_METERS = 70;

function wobbleRadiusMeters(kind: ObstacleKind): number {
  if (kind === "bird") return BIRD_CIRCLE_RADIUS_M;
  if (kind === "helicopter") return HELI_CIRCLE_RADIUS_M;
  if (kind === "drone") return DRONE_CROSS_AMPLITUDE_M;
  return 0; // building, firework — neither translates from its centroid
}

/** Fisher-Yates using a seeded RNG — deterministic across engines, unlike Array.sort(). */
function shuffle<T>(arr: T[], rand: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const KIND_LABELS: Record<ObstacleKind, string[]> = {
  building: ["a rooftop antenna mast", "a construction crane", "a high-rise tower"],
  bird: ["a flock of birds", "a hawk circling", "gulls over the block"],
  drone: ["another drone crossing traffic", "an inbound delivery drone", "a survey drone loitering"],
  helicopter: ["an emergency medevac helicopter", "a police helicopter circling a scene", "a news helicopter on scene"],
  firework: ["a fireworks show in progress", "an aerial firework burst", "a pyrotechnics display overhead"],
};

/**
 * Generates a small, guaranteed obstacle course between any two points —
 * a mix of buildings, birds, and other drones — so the reroute demo works
 * everywhere, not just where OpenStreetMap happens to have tall buildings.
 * Seeded by route so the same corridor gets the same layout each run.
 */
export function generateObstacles(seedKey: string, start: LatLon, end: LatLon, altitudeMeters: number): Obstacle[] {
  const rand = mulberry32(hashString(seedKey));
  const totalDistance = distanceMeters(start, end);
  const course = bearingDeg(start, end);
  const kinds: ObstacleKind[] = ["building", "bird", "drone", "helicopter", "firework"];
  const count = 2 + Math.floor(rand() * 4); // 2-5, guaranteed
  // Cycle through a shuffled kind list rather than picking each independently,
  // so a run of several obstacles reliably mixes kinds instead of
  // occasionally landing on all-buildings by chance.
  const shuffledKinds = shuffle(kinds, rand);
  const kindSequence = Array.from({ length: count }, (_, i) => shuffledKinds[i % shuffledKinds.length]);

  const obstacles: Obstacle[] = [];
  for (let i = 0; i < count; i++) {
    const kind = kindSequence[i];
    const radiusMeters =
      kind === "building" ? 12 + rand() * 10 : kind === "helicopter" ? 14 + rand() * 8 : kind === "firework" ? 20 + rand() * 20 : 8 + rand() * 6;

    // How far this obstacle needs to sit from either endpoint: its own
    // rendered footprint, plus how far it can wander from its centroid
    // (0 for static kinds), plus a flat safety buffer — clamped to a
    // fraction of the corridor's own length so a very short custom
    // corridor can't invert the min/max bounds below.
    const keepAway = Math.min(ENDPOINT_CLEARANCE_METERS + wobbleRadiusMeters(kind) + radiusMeters, totalDistance * 0.4);

    const t = 0.2 + (i / count) * 0.6 + rand() * (0.4 / count); // spread out, clear of the endpoints
    const alongMeters = Math.min(Math.max(t * totalDistance, keepAway), totalDistance - keepAway);
    const side = rand() < 0.5 ? -1 : 1;
    const perpOffsetMeters = 8 + rand() * 18;

    const alongPoint = offsetPoint(start, course, alongMeters);
    const centroid = offsetPoint(alongPoint, course + side * 90, perpOffsetMeters);

    const heightMeters = kind === "building" ? altitudeMeters + 20 + rand() * 60 : altitudeMeters;
    const labels = KIND_LABELS[kind];
    const label = labels[Math.floor(rand() * labels.length)];

    obstacles.push({
      id: `${kind}-${i}`,
      kind,
      label,
      heightMeters,
      centroid,
      radiusMeters,
      distanceAlongPathMeters: alongMeters,
      footprint: buildCirclePolygon(centroid, radiusMeters),
    });
  }

  obstacles.sort((a, b) => a.distanceAlongPathMeters - b.distanceAlongPathMeters);
  return obstacles;
}

export interface SimulatedWind {
  speedMps: number;
  fromDeg: number;
}

/**
 * A fresh, reliably-noticeable wind scenario each time you simulate — not
 * tied to real weather. 6-15 m/s against a 12 m/s default airspeed still
 * forces a clearly visible crab angle almost every run (>=30° whenever the
 * crosswind component exceeds ~6 m/s), while keeping full wind-speed
 * saturation (crosswind >= airspeed, which floors ground speed and can
 * balloon battery drain into an emergency-landing failsafe) an occasional
 * event rather than a coin flip — an earlier 7-19 m/s range made the
 * failsafe trigger on roughly half of all simulated flights, which mostly
 * just cut the interesting reroute/hold demo short instead of showing it.
 */
export function generateSimulatedWind(): SimulatedWind {
  return {
    speedMps: 6 + Math.random() * 9, // 6-15 m/s
    fromDeg: Math.random() * 360,
  };
}
