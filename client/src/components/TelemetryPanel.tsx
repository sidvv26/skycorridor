import type { TelemetryResult } from "../types";

interface TelemetryPanelProps {
  telemetry: TelemetryResult | undefined;
  loading: boolean;
  error: string | undefined;
  onRefresh: () => void;
}

function fmt(n: number, digits = 1): string {
  return n.toFixed(digits);
}

export default function TelemetryPanel({ telemetry, loading, error, onRefresh }: TelemetryPanelProps) {
  return (
    <div className="telemetry-panel">
      <div className="telemetry-header">
        <h2>Telemetry</h2>
        <button onClick={onRefresh} disabled={loading}>
          {loading ? "Fetching wind…" : "Refresh"}
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      {!error && !telemetry && <p className="hint">Select a corridor to compute live telemetry.</p>}

      {telemetry && telemetry.warnings.length > 0 && (
        <ul className="warning-list">
          {telemetry.warnings.map((w) => (
            <li key={w.code} className={`warning-item ${w.severity}`}>
              <strong>{w.severity === "critical" ? "⚠ Critical" : "⚠ Warning"}:</strong> {w.message}
            </li>
          ))}
        </ul>
      )}

      {telemetry && (
        <dl className="telemetry-grid">
          <dt>Live wind</dt>
          <dd>
            {fmt(telemetry.wind.speedMps)} m/s from {fmt(telemetry.wind.fromDeg, 0)}°
            <span className="sub"> (bands: {telemetry.wind.sourceBandsMeters.join("/")} m)</span>
          </dd>

          <dt>Course / distance</dt>
          <dd>
            {fmt(telemetry.courseDeg, 0)}° over {fmt(telemetry.distanceMeters, 0)} m
          </dd>

          <dt>Crab angle</dt>
          <dd className={Math.abs(telemetry.crabAngleDeg) > 15 ? "warn" : ""}>
            {telemetry.crabAngleDeg >= 0 ? "+" : ""}
            {fmt(telemetry.crabAngleDeg)}° (heading {fmt(telemetry.headingDeg, 0)}°)
          </dd>

          <dt>Ground speed</dt>
          <dd>
            {fmt(telemetry.groundSpeedMps)} m/s (airspeed {fmt(telemetry.airspeedMps)} m/s)
          </dd>

          <dt>Crosswind drift</dt>
          <dd>
            {fmt(telemetry.headwindMps)} m/s head, {fmt(telemetry.crosswindMps)} m/s cross
            <span className="sub"> (heading-relative)</span>
          </dd>

          <dt>ETA</dt>
          <dd>{fmt(telemetry.etaSeconds, 0)} s</dd>

          <dt>Power draw</dt>
          <dd>
            {fmt(telemetry.powerWatts, 0)} W
            <span className="sub"> ({fmt(telemetry.powerMultiplier, 2)}× multiplier)</span>
          </dd>

          <dt>Battery drain</dt>
          <dd className={telemetry.batteryDrainPercent > 10 ? "warn" : ""}>
            {fmt(telemetry.batteryDrainPercent, 2)}%
          </dd>

          <dt>Reserve remaining</dt>
          <dd className={telemetry.reservePercent < 20 ? "warn" : ""}>{fmt(telemetry.reservePercent, 1)}%</dd>
        </dl>
      )}
    </div>
  );
}
