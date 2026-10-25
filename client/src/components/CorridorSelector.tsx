import { isCustomCorridor } from "../customCorridors";
import type { Corridor } from "../types";

interface CorridorSelectorProps {
  corridors: Corridor[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  onDeleteCustom: (id: string) => void;
  drawMode: boolean;
  onStartDraw: () => void;
  onCancelDraw: () => void;
}

export default function CorridorSelector({
  corridors,
  selectedId,
  onSelect,
  onDeleteCustom,
  drawMode,
  onStartDraw,
  onCancelDraw,
}: CorridorSelectorProps) {
  return (
    <div className="corridor-selector">
      <div className="corridor-selector-header">
        <h2>Sky Corridors</h2>
        {drawMode ? (
          <button className="draw-btn cancel" onClick={onCancelDraw}>
            Cancel
          </button>
        ) : (
          <button className="draw-btn" onClick={onStartDraw}>
            + Draw new
          </button>
        )}
      </div>

      {drawMode && <p className="draw-hint">Click a start point, then an end point on the map.</p>}

      <ul>
        {corridors.map((c) => (
          <li key={c.id}>
            <button
              className={c.id === selectedId ? "active" : ""}
              onClick={() => onSelect(c.id)}
            >
              <span className="corridor-name">{c.name}</span>
              <span className="corridor-meta">{c.altitudeMeters} m AGL</span>
              <span className="corridor-desc">{c.description}</span>
            </button>
            {isCustomCorridor(c) && (
              <button
                className="delete-btn"
                title="Delete this corridor"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteCustom(c.id);
                }}
              >
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
