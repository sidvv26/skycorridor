import type { TrafficStatusEntry } from "../ambientTraffic";

const STATUS_LABEL: Record<TrafficStatusEntry["status"], string> = {
  clear: "Clear",
  advisory: "Advisory",
  conflict: "Conflict",
};

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
function compassLabel(deg: number): string {
  return COMPASS[Math.round(deg / 45) % 8];
}

interface AirTrafficControlProps {
  entries: TrafficStatusEntry[];
  rerouting: boolean;
}

export default function AirTrafficControl({ entries, rerouting }: AirTrafficControlProps) {
  if (entries.length === 0) return null;

  return (
    <div className="atc-panel">
      <div className="atc-header">
        <h2>Air Traffic Control</h2>
        {rerouting && <span className="atc-holding-badge">🔄 REROUTING</span>}
      </div>
      <ul className="atc-list">
        {entries.map((e) => (
          <li key={e.callsign} className={`atc-row atc-${e.status}`}>
            <span className="atc-dot" />
            <span className="atc-callsign">{e.callsign}</span>
            <span className="atc-distance">{e.distanceMeters.toFixed(0)} m</span>
            <span className="atc-bearing">{compassLabel(e.bearingDeg)}</span>
            <span className="atc-status">{STATUS_LABEL[e.status]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
