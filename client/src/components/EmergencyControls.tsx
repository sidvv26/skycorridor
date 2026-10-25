interface EmergencyControlsProps {
  active: boolean;
  status: string | undefined;
  disabled: boolean;
  onToggle: () => void;
}

export default function EmergencyControls({ active, status, disabled, onToggle }: EmergencyControlsProps) {
  return (
    <div className="emergency-controls">
      <button className={`tfr-btn ${active ? "active" : ""}`} onClick={onToggle} disabled={disabled}>
        {active ? "✕ Clear Emergency TFR" : "🚨 Simulate Emergency TFR"}
      </button>
      {!active && !status && (
        <p className="tfr-hint">Drops a restricted-airspace zone onto the route to trigger live rerouting.</p>
      )}
      {status && <p className="tfr-status">{status}</p>}
    </div>
  );
}
