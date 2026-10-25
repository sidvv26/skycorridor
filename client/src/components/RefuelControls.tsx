interface RefuelControlsProps {
  placing: boolean;
  hasStop: boolean;
  disabled: boolean;
  onStartPlacing: () => void;
  onCancelPlacing: () => void;
  onClear: () => void;
}

export default function RefuelControls({ placing, hasStop, disabled, onStartPlacing, onCancelPlacing, onClear }: RefuelControlsProps) {
  if (placing) {
    return (
      <div className="refuel-controls">
        <button className="refuel-btn active" onClick={onCancelPlacing}>
          ✕ Cancel
        </button>
        <p className="tfr-hint">Click the map to place the refuel stop.</p>
      </div>
    );
  }

  if (hasStop) {
    return (
      <div className="refuel-controls">
        <button className="refuel-btn active" onClick={onClear} disabled={disabled}>
          ✕ Remove Refuel Stop
        </button>
        <p className="tfr-status">🔋 Refuel stop set — the drone will recharge there mid-flight.</p>
      </div>
    );
  }

  return (
    <div className="refuel-controls">
      <button className="refuel-btn" onClick={onStartPlacing} disabled={disabled}>
        🔋 Add Refuel Stop
      </button>
      <p className="tfr-hint">Place a stop along a long route so the battery resets partway through.</p>
    </div>
  );
}
