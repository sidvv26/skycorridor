const SPEED_OPTIONS = [0.25, 0.5, 1, 1.5, 2] as const;

interface SimulationControlsProps {
  disabled: boolean;
  status: string | undefined;
  speed: number;
  onSpeedChange: (speed: number) => void;
  onSimulate: () => void;
}

export default function SimulationControls({ disabled, status, speed, onSpeedChange, onSimulate }: SimulationControlsProps) {
  return (
    <div className="simulation-controls">
      <button className="simulate-btn" onClick={onSimulate} disabled={disabled}>
        ▶ Simulate Flight
      </button>

      <div className="speed-row">
        <span className="speed-label">Speed</span>
        {SPEED_OPTIONS.map((s) => (
          <button
            key={s}
            className={`speed-btn ${s === speed ? "active" : ""}`}
            onClick={() => onSpeedChange(s)}
          >
            {s}×
          </button>
        ))}
      </div>

      {status && <p className="simulate-status">{status}</p>}
    </div>
  );
}
