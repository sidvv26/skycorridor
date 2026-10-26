import maplibregl from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import {
  CONFLICT_RADIUS_METERS,
  computeTrafficStatus,
  generateAmbientTraffic,
  trafficDroneHeading,
  trafficDronePosition,
  type TrafficDrone,
  type TrafficStatusEntry,
} from "../ambientTraffic";
import { getDeconflictedRoute, getLiveWind, getTelemetryForCorridor } from "../api";
import { createDroneElement, createEmojiElement, setDroneRotation, setElementRotation } from "../droneIcon";
import {
  bearingDeg,
  buildCirclePolygon,
  distanceMeters,
  lerpAngleDeg,
  lerpLatLon,
  metersPerPixel,
  offsetPoint,
  pointToSegmentDistanceMeters,
} from "../geo";
import { spawnEmergencyTFR, type Geofence, type RouteSegment, type SegmentSafety } from "../geofence";
import {
  BIRD_CIRCLE_RADIUS_M,
  buildRoutePath,
  DRONE_CROSS_AMPLITUDE_M,
  HELI_CIRCLE_RADIUS_M,
  type Obstacle,
  type ObstacleKind,
  type RoutedSegment,
} from "../obstacles";
import { generateObstacles, generateSimulatedWind } from "../syntheticScenario";
import type { Corridor, LatLon, TelemetryResult } from "../types";

const CORRIDOR_SOURCE = "corridor-ribbon";
const PYLON_SOURCE = "corridor-pylons";
const GROUND_LINE_SOURCE = "corridor-ground-line";
const FLIGHT_PATH_SOURCE = "flight-path-ribbon";
const OBSTACLE_SOURCE = "obstacle-highlight";
const GEOFENCE_SOURCE = "geofence-cylinder";
const SAFETY_PATH_SOURCE = "safety-path-ribbon";
const EMERGENCY_PATH_SOURCE = "emergency-path-ribbon";
const ACTUAL_PATH_SOURCE = "actual-flown-trail";

const SAFETY_COLORS: Record<SegmentSafety, string> = { optimal: "#34d399", detour: "#fbbf24", hazard: "#ef4444" };

const METERS_PER_DEG_LAT = 111_320;
const metersPerDegLon = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);

// "drone" uses a saucer glyph rather than 🚁 so it doesn't visually clash
// with the new, distinct "helicopter" kind — the helicopter emoji is now
// reserved for the real thing (see the emergency-light CSS on its marker).
const OBSTACLE_ICONS: Record<ObstacleKind, string> = { building: "🏗️", bird: "🐦", drone: "🛸", helicopter: "🚁", firework: "🎆" };
const OBSTACLE_COLORS: Record<ObstacleKind, string> = {
  building: "#ef4444",
  bird: "#facc15",
  drone: "#fb923c",
  helicopter: "#f87171",
  firework: "#e879f9",
};

/** A thin rectangular ribbon polygon following start->end, for fill-extrusion. */
function buildRibbonPolygon(
  start: [number, number],
  end: [number, number],
  halfWidthMeters: number,
): GeoJSON.Polygon {
  const [lon1, lat1] = start;
  const [lon2, lat2] = end;
  const midLat = (lat1 + lat2) / 2;
  const dLon = lon2 - lon1;
  const dLat = lat2 - lat1;
  const len = Math.hypot(dLon * metersPerDegLon(midLat), dLat * METERS_PER_DEG_LAT) || 1;

  const perpLon = (-dLat * METERS_PER_DEG_LAT) / len;
  const perpLat = (dLon * metersPerDegLon(midLat)) / len;
  const offsetLon = (perpLon * halfWidthMeters) / metersPerDegLon(midLat);
  const offsetLat = (perpLat * halfWidthMeters) / METERS_PER_DEG_LAT;

  const p1: [number, number] = [lon1 + offsetLon, lat1 + offsetLat];
  const p2: [number, number] = [lon2 + offsetLon, lat2 + offsetLat];
  const p3: [number, number] = [lon2 - offsetLon, lat2 - offsetLat];
  const p4: [number, number] = [lon1 - offsetLon, lat1 - offsetLat];

  return { type: "Polygon", coordinates: [[p1, p2, p3, p4, p1]] };
}

function buildRibbonFeatureCollection(
  points: [number, number][],
  halfWidthMeters: number,
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    features.push({ type: "Feature", properties: {}, geometry: buildRibbonPolygon(points[i], points[i + 1], halfWidthMeters) });
  }
  return { type: "FeatureCollection", features };
}

/** A small square footprint centered on a point, for a vertical "pylon" extrusion. */
function buildPylonSquare(center: [number, number], halfWidthMeters: number): GeoJSON.Polygon {
  const [lon, lat] = center;
  const dLon = halfWidthMeters / metersPerDegLon(lat);
  const dLat = halfWidthMeters / METERS_PER_DEG_LAT;
  return {
    type: "Polygon",
    coordinates: [
      [
        [lon - dLon, lat - dLat],
        [lon + dLon, lat - dLat],
        [lon + dLon, lat + dLat],
        [lon - dLon, lat + dLat],
        [lon - dLon, lat - dLat],
      ],
    ],
  };
}

function severityColor(batteryDrainPercent: number | undefined): string {
  if (batteryDrainPercent === undefined) return "#38bdf8";
  const t = Math.min(Math.max(batteryDrainPercent / 15, 0), 1); // 0-15% mapped to green->red
  const r = Math.round(56 + t * (239 - 56));
  const g = Math.round(189 + t * (68 - 189));
  const b = Math.round(248 + t * (68 - 248));
  return `rgb(${r},${g},${b})`;
}

function emptyFeatureCollection(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

/** The default "overview" camera: both endpoints framed, moderate pitch.
 * Bearing is locked to the corridor's own course (not a fixed compass
 * heading) so the flight always runs "up the screen" — any lateral TFR
 * detour then reads as pure left-right screen movement. A fixed bearing
 * looked fine for corridors that happened to run close to it, but for one
 * running, say, north-east, a real ~200m sideways detour projects mostly
 * into screen depth under the pitched camera and gets foreshortened until
 * it's indistinguishable from flying straight through the obstacle. */
function frameCorridor(map: maplibregl.Map, corridor: Corridor, durationMs = 800) {
  const start: [number, number] = [corridor.start.lon, corridor.start.lat];
  const end: [number, number] = [corridor.end.lon, corridor.end.lat];
  const bounds = new maplibregl.LngLatBounds(start, start).extend(end);
  const course = bearingDeg(corridor.start, corridor.end);
  map.fitBounds(bounds, { padding: 90, pitch: 55, bearing: course, maxZoom: 17, duration: durationMs });
}

/** Enables/disables all user camera controls — locked during the simulation's chase camera. */
function setInteractionsEnabled(map: maplibregl.Map, enabled: boolean): void {
  const method: "enable" | "disable" = enabled ? "enable" : "disable";
  map.dragPan[method]();
  map.scrollZoom[method]();
  map.dragRotate[method]();
  map.touchZoomRotate[method]();
  map.keyboard[method]();
  map.doubleClickZoom[method]();
}

// Hard minimum real-world separation from any other aircraft — never
// allowed to be breached, regardless of how the smoothed sidestep below
// computes out. On its own this isn't enough to look right, though: the
// drone and traffic markers are fixed-size icons (34px / 24px), so at any
// zoom looser than very tight, 10 real meters of separation is fewer
// on-screen pixels than the two icons' own radii — they visually overlap
// ("still looks like it's hitting the plane") even though they never
// actually came closer than this floor. effectiveDangerRadius() below scales
// the floor up by the map's current meters-per-pixel so the icons keep a
// genuine visual gap at whatever zoom the camera happens to be at.
const DANGER_RADIUS_METERS = 10;
const ICON_VISUAL_SEPARATION_PX = 50; // ~half drone icon + half traffic icon + a clear gap
// Cap so an extremely zoomed-out view doesn't demand an absurd real-world
// gap. 80m was the first attempt, but this app's own "overview" camera
// (frameCorridor) commonly lands around zoom 15-15.5 for these corridors —
// measured live, not assumed — where 1 pixel is already ~3+ real meters, so
// even 80m of *real* separation is fewer on-screen pixels than the icons'
// own radii and they visually overlap anyway. 220m covers zoom down to ~14.
const MAX_VISUAL_DANGER_RADIUS_METERS = 220;
// How far the drone slides sideways at most when giving way to traffic —
// needs enough headroom to actually reach the visual danger radius above at
// typical overview zoom, or the smooth sidestep undershoots and the hard
// safety floor has to finish the job with an abrupt correction instead of a
// visible slide.
const EVADE_MAX_OFFSET_METERS = 180;

/** The real minimum separation to enforce this frame: whichever is larger of
 * the fixed physical floor and "enough real meters that the two icons don't
 * visually overlap at the map's current zoom." */
function effectiveDangerRadius(atLat: number, zoom: number): number {
  const visual = ICON_VISUAL_SEPARATION_PX * metersPerPixel(atLat, zoom);
  return Math.max(DANGER_RADIUS_METERS, Math.min(MAX_VISUAL_DANGER_RADIUS_METERS, visual));
}


function obstacleWobbleMetersForVisual(kind: ObstacleKind): number {
  if (kind === "bird") return BIRD_CIRCLE_RADIUS_M;
  if (kind === "helicopter") return HELI_CIRCLE_RADIUS_M;
  if (kind === "drone") return DRONE_CROSS_AMPLITUDE_M;
  return 0;
}

const DRONE_ICON_RADIUS_PX = 17; // half of .drone-icon's 34px width
const OBSTACLE_ICON_RADIUS_PX = 13; // half of .obstacle-icon's 26px width
const TARGET_OBSTACLE_GAP_PX = 40; // clear visual separation beyond the icons just touching

/**
 * Builds the obstacle-course route, then verifies and — if needed —
 * progressively widens it using the map's *actual* projection
 * (map.project()), not an approximated meters-per-pixel conversion.
 *
 * effectiveDangerRadius/metersPerPixel assume a flat top-down (nadir)
 * projection; this camera is pitched 55-64°, under which real screen
 * distance per meter varies continuously across the scene (perspective),
 * not by a fixed ratio. A flat scalar correction (tried first: 1.4x, then
 * 1.8x, then 2.2x the nadir estimate) kept closing the gap empirically but
 * never eliminated it — confirmed by live testing that kept finding
 * occasional negative (overlapping) pixel gaps regardless of the
 * multiplier, because the amount of correction actually needed depends on
 * *where* in the pitched scene the obstacle sits, which a single number
 * can't capture. Projecting the real candidate route and obstacle
 * positions and measuring the real gap removes that guesswork entirely.
 */
function buildVisuallyClearRoute(
  map: maplibregl.Map,
  start: LatLon,
  end: LatLon,
  obstacles: Obstacle[],
  baseAltitudeMeters: number,
  initialClearanceMeters: number,
): RoutedSegment[] {
  let clearance = initialClearanceMeters;
  let routed = buildRoutePath(start, end, obstacles, baseAltitudeMeters, clearance);

  for (let attempt = 0; attempt < 8; attempt++) {
    routed = buildRoutePath(start, end, obstacles, baseAltitudeMeters, clearance);
    let worstGapPx = Infinity;

    for (const obstacle of obstacles) {
      if (obstacle.kind === "building") continue; // climbs over — not a lateral/screen-space concern
      const centroidPx = map.project([obstacle.centroid.lon, obstacle.centroid.lat]);
      const wobbleMeters = obstacleWobbleMetersForVisual(obstacle.kind);
      const wobblePoint = offsetPoint(obstacle.centroid, 0, wobbleMeters || 1);
      const wobblePx = wobbleMeters > 0 ? Math.hypot(...pxDelta(map.project([wobblePoint.lon, wobblePoint.lat]), centroidPx)) : 0;

      let minDistPx = Infinity;
      for (const seg of routed) {
        for (let t = 0; t <= 1; t += 0.05) {
          const p = lerpLatLon(seg.start, seg.end, t);
          const px = map.project([p.lon, p.lat]);
          minDistPx = Math.min(minDistPx, Math.hypot(...pxDelta(px, centroidPx)));
        }
      }

      const obstacleIconRadiusPx = OBSTACLE_ICON_RADIUS_PX + (obstacle.kind === "firework" ? obstacle.radiusMeters / 3 : 0);
      const gapPx = minDistPx - wobblePx - DRONE_ICON_RADIUS_PX - obstacleIconRadiusPx;
      worstGapPx = Math.min(worstGapPx, gapPx);
    }

    if (worstGapPx >= TARGET_OBSTACLE_GAP_PX || obstacles.every((o) => o.kind === "building")) break;
    const widened = Math.min(clearance * 1.5, MAX_VISUAL_DANGER_RADIUS_METERS);
    if (widened === clearance) break; // already at the real-world cap — more attempts won't change anything
    clearance = widened;
  }
  return routed;
}

function pxDelta(a: { x: number; y: number }, b: { x: number; y: number }): [number, number] {
  return [a.x - b.x, a.y - b.y];
}

const GEOFENCE_ICON_RADIUS_PX = 13;
// Absolute ceiling on how far the TFR detour waypoint can sit from the
// fence's center. The adaptive step below estimates real-world meters from
// an on-screen pixel gap by dividing by the local meters-per-pixel ratio at
// the closest-approach point — under the pitched camera, a point that's
// heavily foreshortened (near the horizon) can project only a handful of
// pixels from the fence center despite being genuinely far away in meters,
// making that ratio explode and sending the waypoint kilometers off in a
// single step. Fences only ever have a 90-150m radius, so 600m of real
// clearance from center is already generous; anything past that is the
// runaway case, not a real need.
const MAX_TFR_DETOUR_METERS = 600;

/** Same idea as buildVisuallyClearRoute, for the TFR safety-path: the
 * server's deconfliction endpoint (deconfliction.ts) guarantees the detour
 * waypoint clears the fence by a real-world margin, but that's computed with
 * no knowledge of the client's camera at all — same root cause as the
 * obstacle-course version, so a route that's genuinely safe can still read
 * as "the drone ended up inside the restricted zone" on screen, especially
 * near the destination if the fence happens to sit close to it. Segments
 * come from the server, so this nudges the shared waypoint between the two
 * detour legs further from the fence's center (rather than rebuilding from
 * scratch) until the real projected gap to the fence's rendered edge is
 * enough, or gives up after a few tries (a single climbed segment, or one
 * truly trapped inside the fence, has no lateral waypoint to adjust at all). */
function widenTfrRouteForVisualClearance(map: maplibregl.Map, segments: RouteSegment[], fence: Geofence): RouteSegment[] {
  if (segments.length < 2) return segments;
  let result = segments.map((s) => ({ ...s }));
  const centerPx = map.project([fence.center.lon, fence.center.lat]);

  for (let attempt = 0; attempt < 16; attempt++) {
    const points: LatLon[] = [result[0].start, ...result.map((s) => s.end)];
    let closestIdx = -1;
    let closestDist = Infinity;
    for (let i = 1; i < points.length - 1; i++) {
      const d = distanceMeters(points[i], fence.center);
      if (d < closestDist) {
        closestDist = d;
        closestIdx = i;
      }
    }
    if (closestIdx === -1) break; // no interior waypoint to adjust (e.g. a single climbed/hazard segment)
    const waypoint = points[closestIdx];

    const edgePoint = offsetPoint(fence.center, bearingDeg(fence.center, waypoint), fence.radiusMeters);
    const fenceRadiusPx = Math.hypot(...pxDelta(map.project([edgePoint.lon, edgePoint.lat]), centerPx));

    // Check the real closest approach of the *whole path* to the fence
    // center, not just the waypoint's own distance — a waypoint placed
    // comfortably clear doesn't guarantee the straight segments leading to
    // and from it stay clear too (confirmed live: this exact gap — sampling
    // only the waypoint — let a route through that visually clipped the
    // restricted zone by -21px despite the waypoint itself reading clear).
    let minDistPx = Infinity;
    let closestSamplePoint = waypoint;
    for (const seg of result) {
      for (let t = 0; t <= 1; t += 0.05) {
        const p = lerpLatLon(seg.start, seg.end, t);
        const px = map.project([p.lon, p.lat]);
        const d = Math.hypot(...pxDelta(px, centerPx));
        if (d < minDistPx) {
          minDistPx = d;
          closestSamplePoint = p;
        }
      }
    }
    const gapPx = minDistPx - fenceRadiusPx - DRONE_ICON_RADIUS_PX - GEOFENCE_ICON_RADIUS_PX;

    if (gapPx >= TARGET_OBSTACLE_GAP_PX) break;

    // Adaptive step: estimate the local meters-per-pixel ratio at the
    // actual closest-approach point (not necessarily the waypoint) and use
    // it to jump straight to roughly the needed waypoint distance, rather
    // than growing by a fixed multiplier each pass. A fixed multiplier
    // converges slowly (or not within a small attempt budget) when the
    // detour direction happens to be heavily foreshortened by the pitched
    // camera — pushing further in real meters then buys very few extra
    // pixels — which is exactly the case that needs the most real-world
    // distance, so guessing from the local ratio (with headroom) gets
    // there in far fewer iterations.
    const bearing = bearingDeg(fence.center, waypoint);
    const currentDist = distanceMeters(fence.center, waypoint);
    const closestSampleDistMeters = distanceMeters(fence.center, closestSamplePoint) || 1;
    const localMetersPerPx = closestSampleDistMeters / Math.max(minDistPx, 1);
    const neededExtraPx = TARGET_OBSTACLE_GAP_PX - gapPx;
    const newDist = Math.min(currentDist + neededExtraPx * localMetersPerPx * 1.6, MAX_TFR_DETOUR_METERS);
    if (newDist <= currentDist) break; // already at the real-world cap — further attempts can't improve on this
    points[closestIdx] = offsetPoint(fence.center, bearing, newDist);
    result = points.slice(0, -1).map((p, i) => ({ ...result[i], start: p, end: points[i + 1] }));
  }

  return result;
}

/**
 * If a refuel stop is set for this flight, snaps it onto the nearest point
 * of the already-planned path (whichever one: direct, obstacle-avoidance,
 * or TFR detour — this runs after all of those, so it doesn't need to know
 * which) and splits that leg into two there. Everything downstream — the
 * per-leg telemetry fetch, the animated frame loop, the battery failsafe —
 * already iterates generically over however many legs the path has, so
 * treating the stop as a real intermediate waypoint here means none of that
 * needs special-casing for "there's a stop partway through."
 *
 * Returns `refuelLegIndex`: the index of the first leg that comes *after*
 * the stop in the (possibly now one-longer) segment arrays — null if there
 * is no active stop for this flight. The caller uses it to split the
 * cumulative battery check into two independent halves (so a long route
 * that would fail as one trip can still succeed as two shorter ones) and to
 * trigger a brief in-flight "recharging" pause when the drone reaches it.
 */
function insertRefuelStop(
  path: LatLon[],
  segmentAltitudes: number[],
  refuelStop: LatLon | undefined,
): { path: LatLon[]; segmentAltitudes: number[]; refuelLegIndex: number | null } {
  if (!refuelStop || path.length < 2) return { path, segmentAltitudes, refuelLegIndex: null };

  let bestLeg = 0;
  let bestT = 0.5;
  let bestDist = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    const { distanceMeters: d, t } = pointToSegmentDistanceMeters(refuelStop, path[i], path[i + 1]);
    if (d < bestDist) {
      bestDist = d;
      bestLeg = i;
      bestT = t;
    }
  }
  // Snapping exactly onto an existing waypoint (t=0 or 1) would create a
  // zero-length leg on one side — nudge slightly inward so the stop always
  // splits its leg into two real legs.
  const clampedT = Math.min(0.95, Math.max(0.05, bestT));
  const snapped = lerpLatLon(path[bestLeg], path[bestLeg + 1], clampedT);

  const newPath = [...path.slice(0, bestLeg + 1), snapped, ...path.slice(bestLeg + 1)];
  const newAltitudes = [
    ...segmentAltitudes.slice(0, bestLeg),
    segmentAltitudes[bestLeg],
    segmentAltitudes[bestLeg],
    ...segmentAltitudes.slice(bestLeg + 1),
  ];
  return { path: newPath, segmentAltitudes: newAltitudes, refuelLegIndex: bestLeg + 1 };
}

/** How much to sidestep this frame, and which way, given the nearest traffic
 * contact — perpendicular to the current heading, away from whichever side
 * the intruder is on, growing smoothly as it closes in. Doesn't touch
 * position itself: the caller lerps toward this target and re-checks the
 * hard safety floor every frame (see the frame() loop). `conflictRadiusMeters`
 * is normally CONFLICT_RADIUS_METERS, but is widened when the visual danger
 * radius above is bigger, so there's always room to slide smoothly before
 * the hard floor has to intervene abruptly.
 *
 * `lockedSide` makes the *direction* sticky for an entire evasion episode
 * instead of recomputed fresh every frame. With 3 independently-orbiting
 * traffic drones and a conflict radius wide enough to avoid visual overlap
 * (up to 300m+ at a zoomed-out overview), which contact is "nearest" can
 * swap between drones frame to frame, or the same drone's relative bearing
 * can cross past the heading line as it circles — either one flips a
 * freshly-recomputed side every frame, and with EVADE_MAX_OFFSET_METERS
 * this large, that produced a wildly jagged real path (confirmed by
 * inspecting the actual-flown trail live) instead of one clean sidestep.
 * The caller only passes 0 (meaning "free to choose") once the smoothed
 * offset has fully relaxed back to ~0, so a side picked at the start of an
 * episode holds until that episode is actually over. */
function evasionTarget(
  headingDeg: number,
  nearest: TrafficStatusEntry | undefined,
  conflictRadiusMeters: number,
  lockedSide: -1 | 0 | 1,
): { bearingDeg: number; offsetMeters: number; side: -1 | 0 | 1 } {
  if (!nearest || nearest.distanceMeters >= conflictRadiusMeters) {
    return { bearingDeg: headingDeg, offsetMeters: 0, side: lockedSide };
  }
  const relative = (((nearest.bearingDeg - headingDeg + 540) % 360) - 180);
  const freshSide: -1 | 1 = relative >= 0 ? -1 : 1; // sidestep away from whichever side the traffic is on
  const side = lockedSide !== 0 ? lockedSide : freshSide;
  const closeness = 1 - nearest.distanceMeters / conflictRadiusMeters; // 0 (just entered) .. 1 (right on top)
  return {
    bearingDeg: (headingDeg + side * 90 + 360) % 360,
    offsetMeters: Math.min(EVADE_MAX_OFFSET_METERS, conflictRadiusMeters * 0.4 + closeness * conflictRadiusMeters * 0.8),
    side,
  };
}

const CHASE_PITCH = 64;
const CHASE_ZOOM = 18;
const CHASE_FOLLOW_DISTANCE_METERS = 55;
const ICON_MAX_BANK_DEG = 32; // the drone icon's own visible roll — can be dramatic, it's a small icon
const WORLD_MAX_BANK_DEG = 9; // the whole-canvas CSS tilt — kept subtle so the path stays easy to track
const BANK_SCALE = 1.1; // covers the rotated wrapper's corners up to WORLD_MAX_BANK_DEG

/** Third-person chase camera: trails behind and above the drone, so the drone, the
 * reroute path ahead, and obstacles are all visible at once (unlike a true FPV
 * camera, which sits exactly on the drone and can't see any of those). */
function applyChaseCamera(map: maplibregl.Map, pos: LatLon, bearingDegVal: number): void {
  const behind = offsetPoint(pos, bearingDegVal + 180, CHASE_FOLLOW_DISTANCE_METERS);
  map.jumpTo({ center: [behind.lon, behind.lat], bearing: bearingDegVal, pitch: CHASE_PITCH, zoom: CHASE_ZOOM });
}

/** Fakes a bit of camera roll (MapLibre has none) by tilting the whole map wrapper with CSS. */
function applyBankTilt(wrapper: HTMLDivElement, bankDeg: number): void {
  wrapper.style.transform = bankDeg === 0 ? "none" : `rotate(${bankDeg}deg) scale(${BANK_SCALE})`;
}

const VECTOR_STYLE = "https://tiles.openfreemap.org/styles/liberty";
// Esri's World Imagery tile service — keyless, free for this kind of use, the
// standard "no API key" satellite basemap for open-source map projects.
const SATELLITE_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    satellite: {
      type: "raster",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256,
      attribution: "Esri, Maxar, Earthstar Geographics",
    },
  },
  layers: [{ id: "satellite", type: "raster", source: "satellite" }],
};

// Circling/crossing radii are imported from obstacles.ts — it's the
// authoritative source since buildRoutePath's lateral clearance has to
// account for the same wobble this animation draws (they drifted apart
// once before: the animation radii were bumped for on-screen visibility
// without the route's clearance distance following along, so a "cleared"
// route could still pass through where a circling helicopter or crossing
// drone genuinely travels — see buildRoutePath's doc comment).
const BIRD_ANGULAR_SPEED_DEG_S = 130;
const HELI_ANGULAR_SPEED_DEG_S = 90;
const DRONE_ANGULAR_FREQ_RAD_S = 1.6;
const FIREWORK_PULSE_RATIO = 0.3; // +/- 30% of base radius
const FIREWORK_PULSE_FREQ_RAD_S = 2;

function obstacleFeatureCollection(obstacles: Obstacle[], elapsedSeconds: number, crossBearing: number): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: obstacles.map((o) => {
      const center = animatedObstacleCenter(o, elapsedSeconds, crossBearing);
      const radius = animatedObstacleRadius(o, elapsedSeconds);
      return {
        type: "Feature",
        properties: {
          kind: o.kind,
          color: OBSTACLE_COLORS[o.kind],
          heightMeters: o.kind === "building" ? o.heightMeters : o.heightMeters + 5,
          baseMeters: o.kind === "building" ? 0 : Math.max(o.heightMeters - 5, 0),
        },
        geometry: { type: "Polygon", coordinates: [o.kind === "building" ? o.footprint : buildCirclePolygon(center, radius)] },
      };
    }),
  };
}

/** Buildings hold still; birds circle their spot; helicopters loiter over a
 * wider, faster circle (a scene they're covering); the generic "drone"
 * crosses back and forth through the corridor like actual crossing air
 * traffic; fireworks stay put (see animatedObstacleRadius for their pulse). */
function animatedObstacleCenter(o: Obstacle, elapsedSeconds: number, crossBearing: number): LatLon {
  if (o.kind === "bird") {
    const angle = (elapsedSeconds * BIRD_ANGULAR_SPEED_DEG_S) % 360;
    return offsetPoint(o.centroid, angle, BIRD_CIRCLE_RADIUS_M);
  }
  if (o.kind === "helicopter") {
    const angle = (elapsedSeconds * HELI_ANGULAR_SPEED_DEG_S) % 360;
    return offsetPoint(o.centroid, angle, HELI_CIRCLE_RADIUS_M);
  }
  if (o.kind === "drone") {
    const t = Math.sin(elapsedSeconds * DRONE_ANGULAR_FREQ_RAD_S); // -1..1
    return offsetPoint(o.centroid, crossBearing, t * DRONE_CROSS_AMPLITUDE_M);
  }
  return o.centroid;
}

function animatedObstacleHeading(o: Obstacle, elapsedSeconds: number, crossBearing: number): number {
  if (o.kind === "bird") {
    return (elapsedSeconds * BIRD_ANGULAR_SPEED_DEG_S + 90) % 360; // tangent to its circling path
  }
  if (o.kind === "helicopter") {
    return (elapsedSeconds * HELI_ANGULAR_SPEED_DEG_S + 90) % 360;
  }
  if (o.kind === "drone") {
    const movingForward = Math.cos(elapsedSeconds * DRONE_ANGULAR_FREQ_RAD_S) >= 0;
    return movingForward ? crossBearing : (crossBearing + 180) % 360;
  }
  return 0;
}

/** Only fireworks pulse — a stand-in for successive bursts expanding and
 * fading — everything else keeps its fixed footprint radius. */
function animatedObstacleRadius(o: Obstacle, elapsedSeconds: number): number {
  if (o.kind === "firework") {
    return o.radiusMeters * (1 + FIREWORK_PULSE_RATIO * Math.sin(elapsedSeconds * FIREWORK_PULSE_FREQ_RAD_S));
  }
  return o.radiusMeters;
}

/** The obstacle's current speed and direction of travel, derived from the
 * exact same motion used to animate it above — so the number shown in the
 * click popup always matches what's actually on screen, not a separately
 * eyeballed guess. Stationary kinds (buildings, and fireworks — which pulse
 * in place rather than translate) report 0 speed and a null heading. */
function computeObstacleVelocity(o: Obstacle, elapsedSeconds: number, crossBearing: number): { speedMps: number; headingDeg: number | null } {
  if (o.kind === "bird") {
    const angularSpeedRad = (BIRD_ANGULAR_SPEED_DEG_S * Math.PI) / 180;
    return { speedMps: BIRD_CIRCLE_RADIUS_M * angularSpeedRad, headingDeg: animatedObstacleHeading(o, elapsedSeconds, crossBearing) };
  }
  if (o.kind === "helicopter") {
    const angularSpeedRad = (HELI_ANGULAR_SPEED_DEG_S * Math.PI) / 180;
    return { speedMps: HELI_CIRCLE_RADIUS_M * angularSpeedRad, headingDeg: animatedObstacleHeading(o, elapsedSeconds, crossBearing) };
  }
  if (o.kind === "drone") {
    // Derivative of amplitude*sin(freq*t) is amplitude*freq*cos(freq*t).
    const speedMps = Math.abs(DRONE_CROSS_AMPLITUDE_M * DRONE_ANGULAR_FREQ_RAD_S * Math.cos(elapsedSeconds * DRONE_ANGULAR_FREQ_RAD_S));
    return { speedMps, headingDeg: animatedObstacleHeading(o, elapsedSeconds, crossBearing) };
  }
  return { speedMps: 0, headingDeg: null };
}

/** HTML content for the click-to-inspect obstacle popup: type, size, and the
 * live speed/heading from the exact same motion model driving the on-map
 * animation (computeObstacleVelocity), not a separately-eyeballed guess. */
function obstacleInfoHtml(o: Obstacle, elapsedSeconds: number, crossBearing: number): string {
  const velocity = computeObstacleVelocity(o, elapsedSeconds, crossBearing);
  const kindLabel = o.kind.charAt(0).toUpperCase() + o.kind.slice(1);
  const speedText = velocity.speedMps < 0.1 ? "Stationary" : `${velocity.speedMps.toFixed(1)} m/s (${(velocity.speedMps * 3.6).toFixed(0)} km/h)`;
  const headingText = velocity.headingDeg === null ? "—" : `${Math.round(velocity.headingDeg)}°`;
  const verticalExtent =
    o.kind === "building" ? `${o.heightMeters.toFixed(0)} m tall (ground to top)` : `~10 m thick, centered at ${o.heightMeters.toFixed(0)} m AGL`;
  return `
    <div class="obstacle-popup">
      <div class="obstacle-popup-title">${OBSTACLE_ICONS[o.kind]} ${kindLabel}</div>
      <div class="obstacle-popup-desc">${o.label}</div>
      <dl class="obstacle-popup-stats">
        <dt>Size</dt><dd>${(o.radiusMeters * 2).toFixed(0)} m across</dd>
        <dt>Height</dt><dd>${verticalExtent}</dd>
        <dt>Speed</dt><dd>${speedText}</dd>
        <dt>Heading</dt><dd>${headingText}</dd>
      </dl>
    </div>`;
}

function geofenceFeatureCollection(fence: Geofence): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { baseMeters: fence.baseAltitudeMeters, heightMeters: fence.topAltitudeMeters },
        geometry: { type: "Polygon", coordinates: [buildCirclePolygon(fence.center, fence.radiusMeters, 24)] },
      },
    ],
  };
}

function safetyPathFeatureCollection(segments: RouteSegment[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: segments.map((seg) => ({
      type: "Feature",
      properties: {
        color: SAFETY_COLORS[seg.safety],
        baseMeters: Math.max(seg.altitudeMeters - 4, 0),
        heightMeters: seg.altitudeMeters + 4,
      },
      geometry: buildRibbonPolygon([seg.start.lon, seg.start.lat], [seg.end.lon, seg.end.lat], 9),
    })),
  };
}

/** Same per-leg altitude idea as safetyPathFeatureCollection, for the
 * synthetic obstacle-course path: a leg that climbs over a building (see
 * buildRoutePath) needs to actually render higher, not at one fixed
 * layer-wide altitude regardless of what each leg is flying over. */
function flightPathFeatureCollection(segments: RoutedSegment[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: segments.map((seg) => ({
      type: "Feature",
      properties: {
        baseMeters: Math.max(seg.altitudeMeters - 3, 0),
        heightMeters: seg.altitudeMeters + 3,
      },
      geometry: buildRibbonPolygon([seg.start.lon, seg.start.lat], [seg.end.lon, seg.end.lat], 8),
    })),
  };
}

interface CorridorMapProps {
  corridor: Corridor | undefined;
  batteryDrainPercent: number | undefined;
  drawMode: boolean;
  pendingStart: LatLon | undefined;
  onDrawPoint: (point: LatLon) => void;
  simulateSignal: number;
  simSpeed: number;
  onStatus: (status: string) => void;
  onTrafficUpdate: (entries: TrafficStatusEntry[]) => void;
  onReroutingChange: (rerouting: boolean) => void;
  tfrActive: boolean;
  onGeofenceStatus: (status: string | undefined) => void;
  refuelMode: boolean;
  refuelStop: LatLon | undefined;
  onSetRefuelStop: (point: LatLon) => void;
}

export default function CorridorMap({
  corridor,
  batteryDrainPercent,
  drawMode,
  pendingStart,
  onDrawPoint,
  simulateSignal,
  simSpeed,
  onStatus,
  onTrafficUpdate,
  onReroutingChange,
  tfrActive,
  onGeofenceStatus,
  refuelMode,
  refuelStop,
  onSetRefuelStop,
}: CorridorMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const windHudRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const obstacleMarkersRef = useRef<{ marker: maplibregl.Marker; inner: HTMLDivElement; obstacle: Obstacle }[]>([]);
  const trafficMarkersRef = useRef<{ marker: maplibregl.Marker; inner: HTMLDivElement; drone: TrafficDrone }[]>([]);
  const trafficStartRef = useRef<number>(0);
  const simActiveRef = useRef(false);
  const pendingMarkerRef = useRef<maplibregl.Marker | null>(null);
  const droneMarkerRef = useRef<maplibregl.Marker | null>(null);
  const droneInnerRef = useRef<HTMLDivElement | null>(null);
  const animTokenRef = useRef<{ cancelled: boolean } | null>(null);
  const corridorRef = useRef<Corridor | undefined>(corridor);
  corridorRef.current = corridor;
  const onTrafficUpdateRef = useRef(onTrafficUpdate);
  onTrafficUpdateRef.current = onTrafficUpdate;
  const onReroutingChangeRef = useRef(onReroutingChange);
  onReroutingChangeRef.current = onReroutingChange;
  const geofenceRef = useRef<Geofence | null>(null);
  const geofenceMarkerRef = useRef<maplibregl.Marker | null>(null);
  const refuelStopRef = useRef<LatLon | undefined>(refuelStop);
  refuelStopRef.current = refuelStop;
  const refuelMarkerRef = useRef<maplibregl.Marker | null>(null);
  const onSetRefuelStopRef = useRef(onSetRefuelStop);
  onSetRefuelStopRef.current = onSetRefuelStop;
  const renderLayersRef = useRef<(() => void) | null>(null);
  const [satellite, setSatellite] = useState(false);
  const isFirstStyleRef = useRef(true);
  // "follow" chases the drone close-up (immersive, but start/end and the
  // wider route can go out of frame on longer corridors — no single camera
  // can be both zoomed in tight on a moving point and framing two points a
  // kilometer+ apart). "overview" leaves the camera at whatever frameCorridor
  // last set (both endpoints always in view) and — unlike follow mode —
  // leaves manual pan/zoom/rotate enabled during the flight, since nothing
  // is fighting the user for the camera every frame.
  const [cameraMode, setCameraMode] = useState<"follow" | "overview">("overview");
  const cameraModeRef = useRef(cameraMode);
  cameraModeRef.current = cameraMode;

  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: VECTOR_STYLE,
      center: [-82.46, 27.95], // Tampa, FL — the fallback view before a corridor loads and re-frames the camera
      zoom: 15,
      pitch: 55,
      bearing: -20,
      maxPitch: 85,
      antialias: true,
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    mapRef.current = map;

    const { root, inner } = createDroneElement();
    droneInnerRef.current = inner;
    // Rotation is handled manually on the inner element (see setDroneRotation),
    // not via Marker's own rotation API, so the marker's own rotation stays at 0.
    droneMarkerRef.current = new maplibregl.Marker({ element: root });

    return () => map.remove();
  }, []);

  // Toggle between the vector street style and a keyless satellite raster.
  // setStyle() wipes every source/layer we've added, so once the new style
  // finishes loading we re-run whatever the corridor effect last built.
  // Markers are plain DOM overlays, not part of the style, so they survive.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (isFirstStyleRef.current) {
      isFirstStyleRef.current = false;
      return;
    }
    map.setStyle(satellite ? SATELLITE_STYLE : VECTOR_STYLE);
    map.once("style.load", () => renderLayersRef.current?.());
  }, [satellite]);

  // Keep the latest callback without re-attaching the click listener every render.
  const onDrawPointRef = useRef(onDrawPoint);
  onDrawPointRef.current = onDrawPoint;

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.getCanvas().style.cursor = drawMode ? "crosshair" : "";
    if (!drawMode) return;

    const handleClick = (e: maplibregl.MapMouseEvent) => {
      onDrawPointRef.current({ lat: e.lngLat.lat, lon: e.lngLat.lng });
    };
    map.on("click", handleClick);
    return () => {
      map.off("click", handleClick);
    };
  }, [drawMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    pendingMarkerRef.current?.remove();
    pendingMarkerRef.current = null;
    if (pendingStart) {
      pendingMarkerRef.current = new maplibregl.Marker({ color: "#facc15" })
        .setLngLat([pendingStart.lon, pendingStart.lat])
        .addTo(map);
    }
  }, [pendingStart]);

  // Same single-click pattern as drawMode above, but placing one point
  // rather than two — see insertRefuelStop for what happens to it once a
  // flight is simulated.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.getCanvas().style.cursor = refuelMode ? "crosshair" : drawMode ? "crosshair" : "";
    if (!refuelMode) return;

    const handleClick = (e: maplibregl.MapMouseEvent) => {
      onSetRefuelStopRef.current({ lat: e.lngLat.lat, lon: e.lngLat.lng });
    };
    map.on("click", handleClick);
    return () => {
      map.off("click", handleClick);
    };
  }, [refuelMode, drawMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    refuelMarkerRef.current?.remove();
    refuelMarkerRef.current = null;
    if (refuelStop) {
      const { root } = createEmojiElement("🔋", "refuel-icon");
      refuelMarkerRef.current = new maplibregl.Marker({ element: root }).setLngLat([refuelStop.lon, refuelStop.lat]).addTo(map);
    }
  }, [refuelStop]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !corridor) return;

    // A newly selected corridor invalidates any in-flight simulation.
    if (animTokenRef.current) animTokenRef.current.cancelled = true;
    if (overlayRef.current) overlayRef.current.textContent = "";
    if (windHudRef.current) windHudRef.current.innerHTML = "";
    setInteractionsEnabled(map, true);
    if (containerRef.current) applyBankTilt(containerRef.current, 0);

    const start: [number, number] = [corridor.start.lon, corridor.start.lat];
    const end: [number, number] = [corridor.end.lon, corridor.end.lat];

    const renderLayers = () => {
      const ribbon = buildRibbonPolygon(start, end, 8);
      const pylonA = buildPylonSquare(start, 6);
      const pylonB = buildPylonSquare(end, 6);
      const color = severityColor(batteryDrainPercent);

      const ribbonData: GeoJSON.Feature = { type: "Feature", geometry: ribbon, properties: {} };
      const pylonData: GeoJSON.FeatureCollection = {
        type: "FeatureCollection",
        features: [
          { type: "Feature", geometry: pylonA, properties: {} },
          { type: "Feature", geometry: pylonB, properties: {} },
        ],
      };
      const groundLine: GeoJSON.Feature = {
        type: "Feature",
        geometry: { type: "LineString", coordinates: [start, end] },
        properties: {},
      };

      const ribbonSrc = map.getSource(CORRIDOR_SOURCE) as maplibregl.GeoJSONSource | undefined;
      const pylonSrc = map.getSource(PYLON_SOURCE) as maplibregl.GeoJSONSource | undefined;
      const groundSrc = map.getSource(GROUND_LINE_SOURCE) as maplibregl.GeoJSONSource | undefined;

      if (ribbonSrc && pylonSrc && groundSrc) {
        ribbonSrc.setData(ribbonData);
        pylonSrc.setData(pylonData);
        groundSrc.setData(groundLine);
        map.setPaintProperty(CORRIDOR_SOURCE, "fill-extrusion-color", color);
        map.setPaintProperty(CORRIDOR_SOURCE, "fill-extrusion-base", Math.max(corridor.altitudeMeters - 3, 0));
        map.setPaintProperty(CORRIDOR_SOURCE, "fill-extrusion-height", corridor.altitudeMeters + 3);
        map.setPaintProperty(PYLON_SOURCE, "fill-extrusion-height", corridor.altitudeMeters);
      } else {
        map.addSource(CORRIDOR_SOURCE, { type: "geojson", data: ribbonData });
        map.addSource(PYLON_SOURCE, { type: "geojson", data: pylonData });
        map.addSource(GROUND_LINE_SOURCE, { type: "geojson", data: groundLine });

        map.addLayer({
          id: PYLON_SOURCE,
          type: "fill-extrusion",
          source: PYLON_SOURCE,
          paint: {
            "fill-extrusion-color": "#94a3b8",
            "fill-extrusion-base": 0,
            "fill-extrusion-height": corridor.altitudeMeters,
            "fill-extrusion-opacity": 0.45,
          },
        });

        map.addLayer({
          id: CORRIDOR_SOURCE,
          type: "fill-extrusion",
          source: CORRIDOR_SOURCE,
          paint: {
            "fill-extrusion-color": color,
            "fill-extrusion-base": Math.max(corridor.altitudeMeters - 3, 0),
            "fill-extrusion-height": corridor.altitudeMeters + 3,
            "fill-extrusion-opacity": 0.85,
          },
        });

        map.addLayer({
          id: GROUND_LINE_SOURCE,
          type: "line",
          source: GROUND_LINE_SOURCE,
          paint: {
            "line-color": "#64748b",
            "line-width": 2,
            "line-dasharray": [2, 2],
          },
        });
      }

      if (!map.getSource(FLIGHT_PATH_SOURCE)) {
        map.addSource(FLIGHT_PATH_SOURCE, { type: "geojson", data: emptyFeatureCollection() });
        map.addLayer({
          id: FLIGHT_PATH_SOURCE,
          type: "fill-extrusion",
          source: FLIGHT_PATH_SOURCE,
          paint: {
            // Per-feature base/height (not a fixed layer-wide altitude) so a
            // leg that climbs over a tall building — see buildRoutePath in
            // obstacles.ts — actually renders higher, instead of the whole
            // ribbon floating at one fixed altitude regardless of what it's
            // supposed to be flying over.
            "fill-extrusion-color": "#22d3ee",
            "fill-extrusion-base": ["get", "baseMeters"],
            "fill-extrusion-height": ["get", "heightMeters"],
            "fill-extrusion-opacity": 0.9,
          },
        });
      } else {
        (map.getSource(FLIGHT_PATH_SOURCE) as maplibregl.GeoJSONSource).setData(emptyFeatureCollection());
      }

      if (!map.getSource(OBSTACLE_SOURCE)) {
        map.addSource(OBSTACLE_SOURCE, { type: "geojson", data: emptyFeatureCollection() });
        map.addLayer({
          id: OBSTACLE_SOURCE,
          type: "fill-extrusion",
          source: OBSTACLE_SOURCE,
          paint: {
            "fill-extrusion-color": ["get", "color"],
            "fill-extrusion-base": ["get", "baseMeters"],
            "fill-extrusion-height": ["get", "heightMeters"],
            "fill-extrusion-opacity": 0.55,
          },
        });
      } else {
        (map.getSource(OBSTACLE_SOURCE) as maplibregl.GeoJSONSource).setData(emptyFeatureCollection());
      }

      if (!map.getSource(GEOFENCE_SOURCE)) {
        map.addSource(GEOFENCE_SOURCE, { type: "geojson", data: emptyFeatureCollection() });
        map.addLayer({
          id: GEOFENCE_SOURCE,
          type: "fill-extrusion",
          source: GEOFENCE_SOURCE,
          paint: {
            "fill-extrusion-color": "#f87171",
            "fill-extrusion-base": ["get", "baseMeters"],
            "fill-extrusion-height": ["get", "heightMeters"],
            "fill-extrusion-opacity": 0.35,
          },
        });
      } else {
        (map.getSource(GEOFENCE_SOURCE) as maplibregl.GeoJSONSource).setData(emptyFeatureCollection());
      }

      if (!map.getSource(SAFETY_PATH_SOURCE)) {
        map.addSource(SAFETY_PATH_SOURCE, { type: "geojson", data: emptyFeatureCollection() });
        map.addLayer({
          id: SAFETY_PATH_SOURCE,
          type: "fill-extrusion",
          source: SAFETY_PATH_SOURCE,
          paint: {
            "fill-extrusion-color": ["get", "color"],
            "fill-extrusion-base": ["get", "baseMeters"],
            "fill-extrusion-height": ["get", "heightMeters"],
            "fill-extrusion-opacity": 0.95,
          },
        });
      } else {
        (map.getSource(SAFETY_PATH_SOURCE) as maplibregl.GeoJSONSource).setData(emptyFeatureCollection());
      }

      if (!map.getSource(EMERGENCY_PATH_SOURCE)) {
        map.addSource(EMERGENCY_PATH_SOURCE, { type: "geojson", data: emptyFeatureCollection() });
        map.addLayer({
          id: EMERGENCY_PATH_SOURCE,
          type: "fill-extrusion",
          source: EMERGENCY_PATH_SOURCE,
          paint: {
            "fill-extrusion-color": "#f97316",
            "fill-extrusion-base": Math.max(corridor.altitudeMeters - 3, 0),
            "fill-extrusion-height": corridor.altitudeMeters + 3,
            "fill-extrusion-opacity": 0.95,
          },
        });
      } else {
        (map.getSource(EMERGENCY_PATH_SOURCE) as maplibregl.GeoJSONSource).setData(emptyFeatureCollection());
        map.setPaintProperty(EMERGENCY_PATH_SOURCE, "fill-extrusion-base", Math.max(corridor.altitudeMeters - 3, 0));
        map.setPaintProperty(EMERGENCY_PATH_SOURCE, "fill-extrusion-height", corridor.altitudeMeters + 3);
      }

      // The drone's real, moment-to-moment position during simulation — a
      // thin bright trail laid down live as it flies, distinct from the
      // wider planned-route ribbons above. The plan is computed once before
      // the drone moves; the actual position can still deviate from it live
      // (most notably: sidestepping ambient traffic, see the frame loop's
      // avoidance logic), and until now nothing recorded that deviation
      // anywhere once the moment passed. Kept as its own thin ribbon rather
      // than folded into an existing one so both the plan and the reality
      // stay visible and distinguishable at once — floated well above the
      // planned-route ribbons' altitude band (which all sit within
      // corridor.altitude ± 3-4m) rather than at the same height, since the
      // common case is the actual path coinciding almost exactly with the
      // plan: at the same altitude, this thinner trail would render
      // completely hidden inside the wider planned ribbon instead of
      // reading as its own visible "ghost trail" ribboning along above it.
      const ACTUAL_PATH_HOVER_METERS = 35;
      if (!map.getSource(ACTUAL_PATH_SOURCE)) {
        map.addSource(ACTUAL_PATH_SOURCE, { type: "geojson", data: emptyFeatureCollection() });
        map.addLayer({
          id: ACTUAL_PATH_SOURCE,
          type: "fill-extrusion",
          source: ACTUAL_PATH_SOURCE,
          paint: {
            "fill-extrusion-color": "#f472b6",
            "fill-extrusion-base": corridor.altitudeMeters + ACTUAL_PATH_HOVER_METERS,
            "fill-extrusion-height": corridor.altitudeMeters + ACTUAL_PATH_HOVER_METERS + 3,
            "fill-extrusion-opacity": 1,
          },
        });
      } else {
        (map.getSource(ACTUAL_PATH_SOURCE) as maplibregl.GeoJSONSource).setData(emptyFeatureCollection());
        map.setPaintProperty(ACTUAL_PATH_SOURCE, "fill-extrusion-base", corridor.altitudeMeters + ACTUAL_PATH_HOVER_METERS);
        map.setPaintProperty(ACTUAL_PATH_SOURCE, "fill-extrusion-height", corridor.altitudeMeters + ACTUAL_PATH_HOVER_METERS + 3);
      }
      map.setPaintProperty(CORRIDOR_SOURCE, "fill-extrusion-opacity", 0.85);

      obstacleMarkersRef.current.forEach((m) => m.marker.remove());
      obstacleMarkersRef.current = [];

      trafficMarkersRef.current.forEach((t) => t.marker.remove());
      const midpoint: LatLon = { lat: (corridor.start.lat + corridor.end.lat) / 2, lon: (corridor.start.lon + corridor.end.lon) / 2 };
      trafficMarkersRef.current = generateAmbientTraffic(corridor.id, midpoint).map((drone) => {
        const { root, inner } = createEmojiElement("✈️", "traffic-icon");
        const marker = new maplibregl.Marker({ element: root }).setLngLat([drone.center.lon, drone.center.lat]).addTo(map);
        return { marker, inner, drone };
      });

      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [
        new maplibregl.Marker({ color: "#22c55e" })
          .setLngLat(start)
          .setPopup(new maplibregl.Popup({ offset: 12 }).setText(`${corridor.name} — start`))
          .addTo(map),
        new maplibregl.Marker({ color: "#ef4444" })
          .setLngLat(end)
          .setPopup(new maplibregl.Popup({ offset: 12 }).setText(`${corridor.name} — end`))
          .addTo(map),
      ];

      // Rest the drone at the corridor's start, nose pointed along the course,
      // so it's always visible even before a simulation is run.
      if (droneMarkerRef.current && droneInnerRef.current) {
        droneMarkerRef.current.setLngLat(start).addTo(map);
        const course = bearingDeg(corridor.start, corridor.end);
        setDroneRotation(droneInnerRef.current, course - map.getBearing());
      }

      // A steep pitch plus a post-fit zoom nudge (tried previously to force
      // 3D buildings to render) made fitBounds's own framing unreliable —
      // under pitch, zooming in further from its computed center can push
      // the very endpoints it just fit outside the viewport entirely. A
      // moderate, fixed pitch with generous padding keeps both endpoints
      // (and the drone) reliably on-screen; buildings still render for any
      // corridor short enough that fitBounds lands above their zoom threshold.
      frameCorridor(map, corridor);
    };

    renderLayersRef.current = renderLayers;
    if (map.isStyleLoaded()) {
      renderLayers();
    } else {
      map.once("load", renderLayers);
    }
  }, [corridor, batteryDrainPercent]);

  // Emergency TFR geofencing: spawns/clears a hazard cylinder across the
  // current corridor and recomputes a safety-classified route via the
  // backend's Turf.js deconfliction engine — green (implicit, the plain
  // corridor ribbon) fades out in favor of yellow (detour) or red (hazard)
  // segments once a TFR is active.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !corridor) return;
    const geofenceSrc = map.getSource(GEOFENCE_SOURCE) as maplibregl.GeoJSONSource | undefined;
    const safetySrc = map.getSource(SAFETY_PATH_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (!geofenceSrc || !safetySrc) return;

    if (!tfrActive) {
      geofenceRef.current = null;
      geofenceMarkerRef.current?.remove();
      geofenceMarkerRef.current = null;
      geofenceSrc.setData(emptyFeatureCollection());
      safetySrc.setData(emptyFeatureCollection());
      map.setPaintProperty(CORRIDOR_SOURCE, "fill-extrusion-opacity", 0.85);
      onGeofenceStatus(undefined);
      return;
    }

    let cancelled = false;
    const fence = spawnEmergencyTFR(corridor.start, corridor.end);
    geofenceRef.current = fence;
    geofenceSrc.setData(geofenceFeatureCollection(fence));

    geofenceMarkerRef.current?.remove();
    const { root } = createEmojiElement("🚨", "geofence-icon");
    geofenceMarkerRef.current = new maplibregl.Marker({ element: root }).setLngLat([fence.center.lon, fence.center.lat]).addTo(map);

    onGeofenceStatus("Checking route against active TFR…");

    getDeconflictedRoute(corridor.start, corridor.end, corridor.altitudeMeters, [fence])
      .then((result) => {
        if (cancelled) return;
        // The server's margin is computed with no idea what the client's
        // camera is doing — a route it certifies as clear can still read as
        // "the drone is inside the restricted zone" on screen. See
        // widenTfrRouteForVisualClearance's doc comment.
        const segments = widenTfrRouteForVisualClearance(map, result.segments, fence);
        safetySrc.setData(safetyPathFeatureCollection(segments));
        map.setPaintProperty(CORRIDOR_SOURCE, "fill-extrusion-opacity", 0.12);
        const hazardCount = result.segments.filter((s) => s.safety === "hazard").length;
        if (hazardCount > 0) {
          onGeofenceStatus(
            `❌ Route still crosses restricted airspace (${hazardCount} segment${hazardCount > 1 ? "s" : ""}) — cannot fully clear this TFR.`,
          );
        } else if (result.intersectedGeofenceIds.length > 0) {
          const climbed = result.segments.some((s) => s.altitudeMeters > corridor.altitudeMeters);
          onGeofenceStatus(climbed ? "✓ Rerouted — climbing over the TFR." : "✓ Rerouted around the TFR.");
        } else {
          onGeofenceStatus("Route clear — no intersection with the TFR.");
        }
      })
      .catch((err) => {
        if (!cancelled) onGeofenceStatus(`Deconfliction request failed: ${String(err)}`);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tfrActive, corridor]);

  // Ambient background air traffic keeps circling continuously — independent
  // of any simulation run — so the airspace reads as actually shared/busy.
  // Its start time is shared (trafficStartRef) so the simulation loop can
  // compute the same drones' positions on the same clock for conflict checks.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !corridor) return;
    trafficStartRef.current = performance.now();
    let rafId: number;
    let lastReportMs = 0;

    const tick = (now: number) => {
      const elapsedSeconds = (now - trafficStartRef.current) / 1000;
      trafficMarkersRef.current.forEach(({ marker, inner, drone }) => {
        const pos = trafficDronePosition(drone, elapsedSeconds);
        marker.setLngLat([pos.lon, pos.lat]);
        setElementRotation(inner, trafficDroneHeading(drone, elapsedSeconds) - map.getBearing());
      });

      // While a simulation is running, its own loop reports traffic status
      // relative to the moving drone instead — this idle report would be
      // relative to the stale resting position and would fight with it.
      if (!simActiveRef.current && now - lastReportMs > 400) {
        lastReportMs = now;
        const drones = trafficMarkersRef.current.map((t) => t.drone);
        onTrafficUpdateRef.current(computeTrafficStatus(drones, elapsedSeconds, corridor.start));
      }

      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(rafId);
  }, [corridor]);

  // Drive the flight simulation whenever the parent bumps simulateSignal.
  useEffect(() => {
    if (simulateSignal === 0) return;
    const map = mapRef.current;
    const activeCorridor = corridorRef.current;
    const wrapper = containerRef.current;
    if (!map || !activeCorridor || !droneMarkerRef.current || !droneInnerRef.current || !wrapper) return;

    const token = { cancelled: false };
    animTokenRef.current = token;
    const droneMarker = droneMarkerRef.current;
    const droneInner = droneInnerRef.current;

    const setOverlay = (text: string) => {
      if (overlayRef.current) overlayRef.current.textContent = text;
    };

    const positionDrone = (pos: LatLon, headingDeg: number, bankDeg: number) => {
      droneMarker.setLngLat([pos.lon, pos.lat]);
      setDroneRotation(droneInner, headingDeg - map.getBearing(), bankDeg);
    };

    const restoreAfterFlight = () => {
      simActiveRef.current = false;
      onReroutingChangeRef.current(false);
      trafficMarkersRef.current.forEach(({ marker }) => marker.getElement().classList.remove("traffic-icon--conflict"));
      setInteractionsEnabled(map, true);
      applyBankTilt(wrapper, 0);
      frameCorridor(map, activeCorridor, 1200);
    };

    // Arrow function, not a `function` declaration — TypeScript only carries
    // the `map`/`activeCorridor` null-narrowing above into closures for
    // function expressions, not hoisted function declarations.
    const run = async () => {
      simActiveRef.current = true;
      let wind: { speedMps: number; fromDeg: number };
      try {
        const midpoint = {
          lat: (activeCorridor.start.lat + activeCorridor.end.lat) / 2,
          lon: (activeCorridor.start.lon + activeCorridor.end.lon) / 2,
        };
        wind = await getLiveWind(midpoint, activeCorridor.altitudeMeters);
      } catch {
        // Open-Meteo unreachable or rate-limited — don't block the flight on
        // a third-party API; fall back to a plausible simulated value.
        wind = generateSimulatedWind();
      }
      if (windHudRef.current) {
        windHudRef.current.innerHTML = `<span class="wind-arrow" style="transform:rotate(${(wind.fromDeg + 180) % 360}deg)">➤</span><span>${wind.speedMps.toFixed(1)} m/s wind</span>`;
      }

      const crossBearing = (bearingDeg(activeCorridor.start, activeCorridor.end) + 90) % 360;
      // Updated every frame by animateObstacles(); read on-demand by an
      // obstacle marker's click handler so the info popup can report its
      // live position/speed at click time.
      const obstacleClockRef = { current: 0 };
      const obstacleSrc = map.getSource(OBSTACLE_SOURCE) as maplibregl.GeoJSONSource | undefined;
      const flightSrc = map.getSource(FLIGHT_PATH_SOURCE) as maplibregl.GeoJSONSource | undefined;
      const safetySrc = map.getSource(SAFETY_PATH_SOURCE) as maplibregl.GeoJSONSource | undefined;
      const emergencySrc = map.getSource(EMERGENCY_PATH_SOURCE) as maplibregl.GeoJSONSource | undefined;
      const actualPathSrc = map.getSource(ACTUAL_PATH_SOURCE) as maplibregl.GeoJSONSource | undefined;
      emergencySrc?.setData(emptyFeatureCollection());
      actualPathSrc?.setData(emptyFeatureCollection());

      let obstacles: Obstacle[] = [];
      let path: LatLon[];
      let segmentAltitudes: number[];
      let arrivalStatusMessage = "✅ Arrived at destination.";

      // An active TFR takes priority over the synthetic obstacle course —
      // this is what actually flies the Turf.js-deconflicted route from
      // Phase 1, instead of it being a standalone overview-only demo.
      const activeFence = geofenceRef.current;
      if (activeFence) {
        onStatus("Checking route against active TFR…");
        const deconfliction = await getDeconflictedRoute(activeCorridor.start, activeCorridor.end, activeCorridor.altitudeMeters, [activeFence]);
        // See widenTfrRouteForVisualClearance's doc comment — the server's
        // route is geometrically clear but has no idea what the client's
        // camera is doing, so this is what the drone actually flies, not
        // just what gets drawn.
        const visualSegments = widenTfrRouteForVisualClearance(map, deconfliction.segments, activeFence);
        path = [visualSegments[0].start, ...visualSegments.map((s) => s.end)];
        segmentAltitudes = visualSegments.map((s) => s.altitudeMeters);

        safetySrc?.setData(safetyPathFeatureCollection(visualSegments));
        map.setPaintProperty(CORRIDOR_SOURCE, "fill-extrusion-opacity", 0.12);
        obstacleSrc?.setData(emptyFeatureCollection());
        flightSrc?.setData(emptyFeatureCollection());
        obstacleMarkersRef.current.forEach((m) => m.marker.remove());
        obstacleMarkersRef.current = [];

        const hazardCount = deconfliction.segments.filter((s) => s.safety === "hazard").length;
        onStatus(hazardCount > 0 ? "❌ Route still crosses restricted airspace — flying anyway." : "⚠ TFR detected — rerouting.");
        arrivalStatusMessage = hazardCount > 0 ? "✅ Arrived — route crossed restricted airspace." : "✅ Arrived — rerouted around the TFR.";
      } else {
        onStatus("Scanning airspace for obstacles…");
        obstacles = generateObstacles(activeCorridor.id, activeCorridor.start, activeCorridor.end, activeCorridor.altitudeMeters);
        // Seed at zero extra clearance — buildRoutePath's own margins
        // (corridor half-width, obstacle radius, wobble) already keep the
        // route physically clear. buildVisuallyClearRoute then measures the
        // *actual* on-screen gap against the map's real projection and only
        // widens it the amount this specific obstacle/camera combination
        // needs. Seeding with the worst-case zoom-wide estimate used for
        // real-time ambient-traffic evasion (effectiveDangerRadius) made
        // every route swing that wide even when the real projected gap
        // needed far less, reading as the drone taking unrealistically
        // heavy detours around obstacles it was already clearing.
        const routedSegments = buildVisuallyClearRoute(
          map,
          activeCorridor.start,
          activeCorridor.end,
          obstacles,
          activeCorridor.altitudeMeters,
          0,
        );
        path = [routedSegments[0].start, ...routedSegments.map((s) => s.end)];
        segmentAltitudes = routedSegments.map((s) => s.altitudeMeters);

        obstacleSrc?.setData(obstacleFeatureCollection(obstacles, 0, crossBearing));
        flightSrc?.setData(flightPathFeatureCollection(routedSegments));
        obstacleMarkersRef.current.forEach((m) => m.marker.remove());
        obstacleMarkersRef.current = obstacles.map((o) => {
          const { root, inner } = createEmojiElement(OBSTACLE_ICONS[o.kind], "obstacle-icon");
          if (o.kind === "helicopter") root.classList.add("obstacle-icon--emergency");
          const marker = new maplibregl.Marker({ element: root }).setLngLat([o.centroid.lon, o.centroid.lat]).addTo(map);
          root.style.cursor = "pointer";
          root.addEventListener("click", (e) => {
            e.stopPropagation();
            const t = obstacleClockRef.current;
            const center = animatedObstacleCenter(o, t, crossBearing);
            new maplibregl.Popup({ offset: 16, closeButton: true, className: "obstacle-popup-wrapper" })
              .setLngLat([center.lon, center.lat])
              .setHTML(obstacleInfoHtml(o, t, crossBearing))
              .addTo(map);
          });
          return { marker, inner, obstacle: o };
        });

        const labels = obstacles.map((o) => o.label).join(", ");
        const climbedCount = routedSegments.filter((s) => s.altitudeMeters > activeCorridor.altitudeMeters).length;
        const climbNote = climbedCount > 0 ? ` — climbing over ${climbedCount} building${climbedCount > 1 ? "s" : ""}` : "";
        onStatus(`⚠ ${obstacles.length} obstacle${obstacles.length > 1 ? "s" : ""} detected (${labels}) — rerouting${climbNote}.`);
        arrivalStatusMessage =
          obstacles.length > 0
            ? `✅ Arrived — rerouted around ${obstacles.length} obstacle${obstacles.length > 1 ? "s" : ""}${climbNote}.`
            : "✅ Arrived at destination.";
      }

      // If a refuel stop is set, splice it into whichever path was just
      // planned above (direct, obstacle-avoidance, or TFR detour) as a real
      // intermediate waypoint — see insertRefuelStop's doc comment for why
      // this is the one place that needs to know about it.
      const refuelResult = insertRefuelStop(path, segmentAltitudes, refuelStopRef.current);
      path = refuelResult.path;
      segmentAltitudes = refuelResult.segmentAltitudes;
      let refuelLegIndex = refuelResult.refuelLegIndex;
      if (refuelLegIndex !== null) {
        arrivalStatusMessage = arrivalStatusMessage.replace(/\.$/, ", with a refuel stop along the way.");
      }

      // Birds/helicopters circle, the generic drone crosses the corridor,
      // fireworks pulse in place, buildings hold still. A no-op (empty
      // array) once a TFR or the failsafe below is in play. The clock ref
      // lets a marker's click handler (bound once, at creation) look up
      // "what time is it right now" on demand, so the info popup reports
      // the obstacle's live position/speed at the moment it's clicked
      // rather than whatever it was when the marker was first created.
      const animateObstacles = (elapsedSeconds: number) => {
        obstacleClockRef.current = elapsedSeconds;
        obstacleSrc?.setData(obstacleFeatureCollection(obstacles, elapsedSeconds, crossBearing));
        obstacleMarkersRef.current.forEach(({ marker, inner, obstacle }) => {
          const center = animatedObstacleCenter(obstacle, elapsedSeconds, crossBearing);
          marker.setLngLat([center.lon, center.lat]);
          setElementRotation(inner, animatedObstacleHeading(obstacle, elapsedSeconds, crossBearing) - map.getBearing());
        });
      };

      if (token.cancelled) return;

      let segmentTelemetry: TelemetryResult[];
      try {
        segmentTelemetry = await Promise.all(
          path.slice(0, -1).map((segStart, i) =>
            getTelemetryForCorridor(
              {
                id: `sim-segment-${i}`,
                name: "simulation segment",
                description: "",
                start: segStart,
                end: path[i + 1],
                altitudeMeters: segmentAltitudes[i],
              },
              wind,
            ),
          ),
        );
      } catch (err) {
        onStatus(`Simulation failed: ${String(err)}`);
        return;
      }
      if (token.cancelled) return;

      // Emergency failsafe: if the planned route (direct, obstacle-avoidance,
      // or TFR detour) would leave insufficient battery reserve, don't fly
      // it — divert to a designated safe landing zone near the launch point.
      // Each segment's own batteryDrainPercent is computed against a full
      // battery independently (it has no notion of "this is leg 3 of 4"), so
      // checking any single segment's warnings would false-trigger on one
      // unlucky detour leg even when the *cumulative* trip is well within
      // budget — sum drain across all legs first, matching the same 80%
      // (100 - SAFETY_THRESHOLDS.minReservePercent) reserve threshold used
      // server-side. A refuel stop splits this into two independent checks
      // — the battery is treated as topped back up to full there — so a
      // route that would fail as one long trip can still succeed as two
      // shorter ones either side of the stop. (If one half alone is still
      // over budget, this falls back to the same full-abort behavior as a
      // flight with no refuel stop at all — a smarter "fly the good half,
      // then divert" isn't implemented yet.)
      const beforeRefuelDrain = segmentTelemetry.slice(0, refuelLegIndex ?? segmentTelemetry.length).reduce((sum, t) => sum + t.batteryDrainPercent, 0);
      const afterRefuelDrain =
        refuelLegIndex !== null ? segmentTelemetry.slice(refuelLegIndex).reduce((sum, t) => sum + t.batteryDrainPercent, 0) : 0;
      const failsafeTriggered = beforeRefuelDrain > 80 || afterRefuelDrain > 80;
      if (failsafeTriggered) {
        const landingPoint = offsetPoint(activeCorridor.start, bearingDeg(activeCorridor.start, activeCorridor.end) - 90, 70);
        try {
          const landingTelemetry = await getTelemetryForCorridor(
            {
              id: "failsafe-landing",
              name: "Emergency Landing",
              description: "",
              start: activeCorridor.start,
              end: landingPoint,
              altitudeMeters: activeCorridor.altitudeMeters,
            },
            wind,
          );
          // The planned route (obstacle-avoidance ribbon, TFR safety-path,
          // whichever was already drawn above) is deliberately left in place
          // rather than cleared — the point is to see both what was *planned*
          // and what was actually *flown* instead, not just the aftermath.
          // Only the drone's actual flight path changes to the diversion.
          path = [activeCorridor.start, landingPoint];
          segmentTelemetry = [landingTelemetry];
          refuelLegIndex = null; // the diversion bypasses the stop entirely
          emergencySrc?.setData(buildRibbonFeatureCollection(path.map((p) => [p.lon, p.lat]), 9));
          onStatus("🚨 EMERGENCY FAILSAFE — insufficient battery reserve for the planned route (still shown). Diverting to emergency landing zone (orange).");
          arrivalStatusMessage = "🛬 Emergency landing complete — the planned route (still visible) would have left insufficient battery reserve.";
        } catch (err) {
          onStatus(`Simulation failed computing failsafe route: ${String(err)}`);
          return;
        }
      }
      if (token.cancelled) return;

      const totalRealSeconds = segmentTelemetry.reduce((sum, t) => sum + t.etaSeconds, 0) || 1;
      const baseSimSeconds = Math.min(15, Math.max(5, totalRealSeconds / 40));
      const totalSimSeconds = Math.min(60, baseSimSeconds / simSpeed);
      const scale = totalSimSeconds / totalRealSeconds;
      const segDurationsMs = segmentTelemetry.map((t) => Math.max(t.etaSeconds * scale * 1000, 200));
      const cumulativeMs: number[] = [];
      segDurationsMs.reduce((acc, d) => {
        const next = acc + d;
        cumulativeMs.push(next);
        return next;
      }, 0);
      const totalMs = cumulativeMs[cumulativeMs.length - 1];

      const startTime = performance.now();
      let cameraBearing = segmentTelemetry[0].headingDeg;
      let iconBank = 0;
      let worldBank = 0;
      let lastFrameNow = startTime;
      let reportedRerouting = false;
      let lastTrafficReportMs = 0;
      // Smoothed sidestep state — see evasionTarget(). Kept across frames so
      // entering/leaving a traffic conflict slides the drone out of the way
      // and back rather than snapping to an offset instantly.
      let evadeOffsetMeters = 0;
      let evadeBearingDeg = segmentTelemetry[0].headingDeg;
      // Which side of the heading the drone is currently sidestepping toward
      // — 0 means "no active episode, free to pick either side next time
      // evasion is needed." See evasionTarget()'s doc comment for why this
      // has to be sticky rather than recomputed every frame.
      let evadeSide: -1 | 0 | 1 = 0;
      // The drone's real position history, laid down as a thin trail (see
      // ACTUAL_PATH_SOURCE above) — only appended once it's moved a little
      // from the last recorded point, so a long flight doesn't accumulate an
      // enormous polyline out of near-duplicate points every frame.
      const actualPathPoints: [number, number][] = [[path[0].lon, path[0].lat]];
      const ACTUAL_PATH_MIN_STEP_METERS = 3;
      // Brief, one-time pause when the drone reaches the refuel stop — see
      // insertRefuelStop. Unlike the old ambient-traffic hold (removed: it
      // could freeze repeatedly and for an unpredictable total duration),
      // this fires at most once per flight, for a short fixed span,
      // regardless of playback speed.
      const RECHARGE_PAUSE_MS = 1400;
      let rechargeHeldMs = 0;
      let rechargeStartedAtMs: number | null = null;
      let rechargeDone = refuelLegIndex === null;
      // Overview mode leaves the camera wherever frameCorridor put it (both
      // endpoints in view) and doesn't fight the user for control; only
      // follow mode chases the drone and locks out manual pan/zoom/rotate.
      if (cameraModeRef.current === "follow") setInteractionsEnabled(map, false);

      const frame = (now: number) => {
        if (token.cancelled) return;
        const dt = now - lastFrameNow;
        lastFrameNow = now;
        const elapsed = now - startTime - rechargeHeldMs;
        animateObstacles(elapsed / 1000);

        const arrived = elapsed >= totalMs;
        let pos: LatLon;
        let heading: number;
        let segIndex = -1;
        if (arrived) {
          pos = path[path.length - 1];
          heading = segmentTelemetry[segmentTelemetry.length - 1].headingDeg;
        } else {
          segIndex = cumulativeMs.findIndex((c) => elapsed < c);
          if (segIndex === -1) segIndex = cumulativeMs.length - 1;
          const segStartMs = segIndex === 0 ? 0 : cumulativeMs[segIndex - 1];
          const segT = Math.min(1, (elapsed - segStartMs) / segDurationsMs[segIndex]);
          pos = lerpLatLon(path[segIndex], path[segIndex + 1], segT);
          heading = segmentTelemetry[segIndex].headingDeg;
        }

        // Pause once at the refuel stop (if any) — detected a frame late
        // (this frame still renders using the elapsed time computed above,
        // before this addition to rechargeHeldMs takes effect), which is
        // imperceptible at 60fps and far simpler than reworking the
        // position/segIndex computation above to react within the same
        // frame it's detected in.
        let rechargingNow = false;
        if (!rechargeDone && refuelLegIndex !== null && !arrived && segIndex >= refuelLegIndex) {
          if (rechargeStartedAtMs === null) rechargeStartedAtMs = now;
          if (now - rechargeStartedAtMs < RECHARGE_PAUSE_MS) {
            rechargeHeldMs += dt;
            rechargingNow = true;
          } else {
            rechargeDone = true;
          }
        }

        // Ambient-traffic avoidance — Waze-style live rerouting. The old
        // behavior froze the drone in place on conflict, but that only
        // stopped *our* progress: the intruder kept orbiting and could still
        // fly straight through a stationary drone (the reported crash).
        // Instead, sidestep smoothly perpendicular to the heading, away from
        // whichever side the nearest contact is on, growing as it closes in
        // and relaxing once clear — then re-check a hard safety floor so
        // real separation from every contact never drops under the current
        // effective danger radius, no matter what the smoothing computes.
        const trafficElapsedSeconds = (now - trafficStartRef.current) / 1000;
        const trafficDrones = trafficMarkersRef.current.map((t) => t.drone);
        const nominalStatus = computeTrafficStatus(trafficDrones, trafficElapsedSeconds, pos);
        const nearestTraffic = nominalStatus[0];

        // Scales with the map's current zoom (see effectiveDangerRadius) so
        // the two fixed-pixel-size icons keep a genuine visual gap instead of
        // just a real-but-imperceptible few meters —10 real meters is only a
        // handful of pixels once the camera is zoomed out even a little, and
        // the icons visually overlap ("still looks like it's hitting") well
        // before the physical floor is actually breached.
        const dangerRadius = effectiveDangerRadius(pos.lat, map.getZoom());
        const conflictRadius = Math.max(CONFLICT_RADIUS_METERS, dangerRadius * 1.6);

        const evadeTarget = arrived
          ? { bearingDeg: heading, offsetMeters: 0, side: evadeSide }
          : evasionTarget(heading, nearestTraffic, conflictRadius, evadeSide);
        evadeSide = evadeTarget.side;
        evadeOffsetMeters += (evadeTarget.offsetMeters - evadeOffsetMeters) * 0.18;
        evadeBearingDeg = lerpAngleDeg(evadeBearingDeg, evadeTarget.bearingDeg, 0.18);
        // Only release the lock once the *smoothed* offset has actually
        // relaxed back down — releasing it as soon as the raw target drops
        // to 0 would let a new contact approaching from the other side
        // re-lock a flipped direction mid-slide, while the drone is still
        // visibly moving from the previous episode's sidestep.
        if (evadeTarget.offsetMeters === 0 && evadeOffsetMeters < 1) {
          evadeSide = 0;
        }
        if (evadeOffsetMeters > 0.5) {
          pos = offsetPoint(pos, evadeBearingDeg, evadeOffsetMeters);
        }

        // Hard floor: whatever the smoothed sidestep above computed, never
        // allow actual separation from any contact to drop under dangerRadius.
        // Escaping away from a single worst offender, or even the raw sum of
        // every violator's push vector, can fail to converge or cancel to
        // ~0 when the drone is boxed in by traffic on opposite sides —
        // escaping away from the violators' *centroid* avoids that
        // cancellation. A fixed pass budget can still graze the floor on
        // pathological clusters (verified by a 30k-trial Monte Carlo stress
        // test replicating this exact math against up to 10 tightly-packed
        // contacts — production only ever has 3, far apart), so anything
        // still violating after the relaxation loop gets a mathematically
        // guaranteed correction: by the triangle inequality, a point far
        // enough from the centroid of *all* contacts is at least
        // dangerRadius from every one of them individually, regardless of
        // how they're arranged.
        const trafficPositions = trafficDrones.map((d) => trafficDronePosition(d, trafficElapsedSeconds));
        for (let pass = 0; pass < 20; pass++) {
          const violators = trafficPositions.filter((p) => distanceMeters(pos, p) < dangerRadius);
          if (violators.length === 0) break;
          const centroid = {
            lat: violators.reduce((s, p) => s + p.lat, 0) / violators.length,
            lon: violators.reduce((s, p) => s + p.lon, 0) / violators.length,
          };
          const distToCentroid = distanceMeters(pos, centroid);
          const escapeBearing = distToCentroid < 1e-6 ? Math.random() * 360 : bearingDeg(centroid, pos);
          const maxPush = Math.max(...violators.map((p) => dangerRadius - distanceMeters(pos, p))) + 2;
          pos = offsetPoint(pos, escapeBearing, maxPush);
        }
        if (trafficPositions.some((p) => distanceMeters(pos, p) < dangerRadius)) {
          const centroidAll = {
            lat: trafficPositions.reduce((s, p) => s + p.lat, 0) / trafficPositions.length,
            lon: trafficPositions.reduce((s, p) => s + p.lon, 0) / trafficPositions.length,
          };
          const maxSpread = Math.max(...trafficPositions.map((p) => distanceMeters(centroidAll, p)));
          const distToCentroidAll = distanceMeters(pos, centroidAll);
          const escapeBearing = distToCentroidAll < 1e-6 ? Math.random() * 360 : bearingDeg(centroidAll, pos);
          pos = offsetPoint(centroidAll, escapeBearing, maxSpread + dangerRadius + 5);
        }

        // `pos` is now final for this frame (post-evasion, post-safety-net)
        // — lay it into the actual-flown trail.
        const lastRecorded = actualPathPoints[actualPathPoints.length - 1];
        if (distanceMeters({ lat: lastRecorded[1], lon: lastRecorded[0] }, pos) >= ACTUAL_PATH_MIN_STEP_METERS) {
          actualPathPoints.push([pos.lon, pos.lat]);
          actualPathSrc?.setData(buildRibbonFeatureCollection(actualPathPoints, 5));
        }

        const trafficStatus = computeTrafficStatus(trafficDrones, trafficElapsedSeconds, pos);
        if (now - lastTrafficReportMs > 200) {
          lastTrafficReportMs = now;
          onTrafficUpdateRef.current(trafficStatus);
        }
        trafficMarkersRef.current.forEach(({ marker, drone }) => {
          const entry = trafficStatus.find((s) => s.callsign === drone.callsign);
          marker.getElement().classList.toggle("traffic-icon--conflict", entry?.status === "conflict");
        });

        const rerouting = evadeOffsetMeters > 3;
        // Report the *actual* current distance to this contact (post-evasion,
        // matching the ATC panel), not the pre-evasion nominal-path distance
        // that triggered the sidestep — otherwise the overlay could flash a
        // scary "5 m" close call for a contact the safety system had already
        // pushed well clear of, contradicting the ATC panel's own number for
        // the same aircraft.
        const reroutingContact = rerouting && nearestTraffic ? trafficStatus.find((s) => s.callsign === nearestTraffic.callsign) : undefined;
        const reroutePrefix = reroutingContact ? `🔄 Rerouting around ${reroutingContact.callsign} (${reroutingContact.distanceMeters.toFixed(0)} m) — ` : "";
        if (reroutingContact) {
          if (!reportedRerouting) {
            reportedRerouting = true;
            onReroutingChangeRef.current(true);
          }
          onStatus(`🔄 Rerouting around ${reroutingContact.callsign} — giving way, ${reroutingContact.distanceMeters.toFixed(0)} m away.`);
        } else if (reportedRerouting) {
          reportedRerouting = false;
          onReroutingChangeRef.current(false);
        }

        if (arrived) {
          cameraBearing = lerpAngleDeg(cameraBearing, heading, 0.2);
          worldBank = worldBank * 0.8;
          if (cameraModeRef.current === "follow") {
            applyChaseCamera(map, pos, cameraBearing);
            applyBankTilt(wrapper, worldBank);
          }
          positionDrone(pos, heading, 0);
          setOverlay(`Arrived — final heading ${heading.toFixed(0)}°`);
          onStatus(arrivalStatusMessage);
          setTimeout(() => {
            if (token.cancelled) return;
            restoreAfterFlight();
          }, 1500);
          return;
        }

        const telemetry = segmentTelemetry[segIndex];
        const targetIconBank = Math.max(-ICON_MAX_BANK_DEG, Math.min(ICON_MAX_BANK_DEG, telemetry.crabAngleDeg));
        const targetWorldBank = Math.max(-WORLD_MAX_BANK_DEG, Math.min(WORLD_MAX_BANK_DEG, telemetry.crabAngleDeg * 0.3));

        cameraBearing = lerpAngleDeg(cameraBearing, telemetry.headingDeg, 0.08);
        iconBank = iconBank + (targetIconBank - iconBank) * 0.1;
        worldBank = worldBank + (targetWorldBank - worldBank) * 0.1;
        if (cameraModeRef.current === "follow") {
          applyChaseCamera(map, pos, cameraBearing);
          applyBankTilt(wrapper, worldBank);
        }
        positionDrone(pos, telemetry.headingDeg, iconBank);
        if (rechargingNow) {
          setOverlay("🔋 Recharging at the stop…");
          onStatus("🔋 Recharging at the stop…");
        } else {
          setOverlay(
            `${reroutePrefix}Leg ${segIndex + 1}/${segmentTelemetry.length} — heading ${telemetry.headingDeg.toFixed(0)}°, crab ${telemetry.crabAngleDeg.toFixed(1)}°, wind ${telemetry.wind.speedMps.toFixed(1)} m/s`,
          );
        }

        requestAnimationFrame(frame);
      };

      onStatus("Flight in progress…");
      requestAnimationFrame(frame);
    };

    run();

    return () => {
      token.cancelled = true;
      simActiveRef.current = false;
      onReroutingChangeRef.current(false);
      trafficMarkersRef.current.forEach(({ marker }) => marker.getElement().classList.remove("traffic-icon--conflict"));
      setInteractionsEnabled(map, true);
      applyBankTilt(wrapper, 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simulateSignal]);

  return (
    <div className="corridor-map">
      <div ref={containerRef} className="map-canvas-wrapper" />
      <button className="satellite-toggle" onClick={() => setSatellite((s) => !s)}>
        {satellite ? "🗺️ Map" : "🛰️ Satellite"}
      </button>
      <button
        className="camera-toggle"
        onClick={() => setCameraMode((m) => (m === "follow" ? "overview" : "follow"))}
        title="Overview keeps both endpoints in view and lets you pan/zoom freely; Follow chases the drone up close"
      >
        {cameraMode === "follow" ? "🗺️ Overview" : "🎥 Follow Drone"}
      </button>
      <div ref={overlayRef} className="sim-status-overlay" />
      <div ref={windHudRef} className="wind-hud" />
    </div>
  );
}
