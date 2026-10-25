import { useCallback, useEffect, useState } from "react";
import type { TrafficStatusEntry } from "./ambientTraffic";
import { getCorridors, getTelemetry, getTelemetryForCorridor } from "./api";
import AirTrafficControl from "./components/AirTrafficControl";
import CorridorMap from "./components/CorridorMap";
import CorridorSelector from "./components/CorridorSelector";
import EmergencyControls from "./components/EmergencyControls";
import RefuelControls from "./components/RefuelControls";
import SimulationControls from "./components/SimulationControls";
import TelemetryPanel from "./components/TelemetryPanel";
import { addCustomCorridor, isCustomCorridor, loadCustomCorridors, removeCustomCorridor } from "./customCorridors";
import type { Corridor, LatLon, TelemetryResult } from "./types";

export default function App() {
  const [predefined, setPredefined] = useState<Corridor[]>([]);
  const [custom, setCustom] = useState<Corridor[]>(() => loadCustomCorridors());
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [telemetry, setTelemetry] = useState<TelemetryResult | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [drawMode, setDrawMode] = useState(false);
  const [pendingStart, setPendingStart] = useState<LatLon | undefined>();
  const [simulateSignal, setSimulateSignal] = useState(0);
  const [simStatus, setSimStatus] = useState<string | undefined>();
  const [simRunning, setSimRunning] = useState(false);
  const [simSpeed, setSimSpeed] = useState(1);
  const [trafficStatus, setTrafficStatus] = useState<TrafficStatusEntry[]>([]);
  const [rerouting, setRerouting] = useState(false);
  const [tfrActive, setTfrActive] = useState(false);
  const [geofenceStatus, setGeofenceStatus] = useState<string | undefined>();
  const [refuelMode, setRefuelMode] = useState(false);
  const [refuelStop, setRefuelStop] = useState<LatLon | undefined>();

  const corridors = [...predefined, ...custom];

  useEffect(() => {
    getCorridors()
      .then((list) => {
        setPredefined(list);
        if (list.length > 0) setSelectedId(list[0].id);
      })
      .catch((err) => setError(String(err)));
  }, []);

  const loadTelemetry = useCallback((corridor: Corridor) => {
    setLoading(true);
    setError(undefined);
    const request = isCustomCorridor(corridor) ? getTelemetryForCorridor(corridor) : getTelemetry(corridor.id);
    request.then(setTelemetry).catch((err) => setError(String(err))).finally(() => setLoading(false));
  }, []);

  const selectedCorridor = corridors.find((c) => c.id === selectedId);

  useEffect(() => {
    if (selectedCorridor) loadTelemetry(selectedCorridor);
    setSimStatus(undefined);
    setSimRunning(false);
    setTfrActive(false);
    setGeofenceStatus(undefined);
    setRefuelMode(false);
    setRefuelStop(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, loadTelemetry]);

  const handleStartDraw = () => {
    setDrawMode(true);
    setPendingStart(undefined);
    setRefuelMode(false);
  };

  const handleCancelDraw = () => {
    setDrawMode(false);
    setPendingStart(undefined);
  };

  const handleStartRefuelPlacing = () => {
    setRefuelMode(true);
    setDrawMode(false);
    setPendingStart(undefined);
  };

  const handleCancelRefuelPlacing = () => {
    setRefuelMode(false);
  };

  const handleSetRefuelStop = (point: LatLon) => {
    setRefuelStop(point);
    setRefuelMode(false);
  };

  const handleClearRefuelStop = () => {
    setRefuelStop(undefined);
  };

  const handleDrawPoint = (point: LatLon) => {
    if (!pendingStart) {
      setPendingStart(point);
      return;
    }
    const corridor = addCustomCorridor(pendingStart, point);
    setCustom(loadCustomCorridors());
    setDrawMode(false);
    setPendingStart(undefined);
    setSelectedId(corridor.id);
  };

  const handleDeleteCustom = (id: string) => {
    const remaining = removeCustomCorridor(id);
    setCustom(remaining);
    if (selectedId === id) {
      const fallback = [...predefined, ...remaining][0];
      setSelectedId(fallback?.id);
    }
  };

  const handleSimulate = () => {
    setSimRunning(true);
    setSimStatus("Starting simulation…");
    setSimulateSignal((n) => n + 1);
  };

  const handleSimStatus = (status: string) => {
    setSimStatus(status);
    // Terminal statuses only — an emergency landing ("🛬") is also a
    // completed run, not still in progress; missing it here left the
    // Simulate button stuck disabled after any failsafe-triggered landing.
    if (status.startsWith("✅") || status.startsWith("🛬") || status.startsWith("Simulation failed")) {
      setSimRunning(false);
    }
  };

  const handleToggleTfr = () => {
    setTfrActive((v) => !v);
  };

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-icon">🛰️</div>
          <div>
            <h1>SkyCorridor</h1>
            <p className="brand-subtitle">Live drone corridor simulation</p>
          </div>
        </div>
        <CorridorSelector
          corridors={corridors}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onDeleteCustom={handleDeleteCustom}
          drawMode={drawMode}
          onStartDraw={handleStartDraw}
          onCancelDraw={handleCancelDraw}
        />
        <SimulationControls
          disabled={!selectedCorridor || simRunning || drawMode || refuelMode}
          status={simStatus}
          speed={simSpeed}
          onSpeedChange={setSimSpeed}
          onSimulate={handleSimulate}
        />
        <EmergencyControls
          active={tfrActive}
          status={geofenceStatus}
          disabled={!selectedCorridor || drawMode}
          onToggle={handleToggleTfr}
        />
        <RefuelControls
          placing={refuelMode}
          hasStop={!!refuelStop}
          disabled={!selectedCorridor || drawMode}
          onStartPlacing={handleStartRefuelPlacing}
          onCancelPlacing={handleCancelRefuelPlacing}
          onClear={handleClearRefuelStop}
        />
        <AirTrafficControl entries={trafficStatus} rerouting={rerouting} />
        <TelemetryPanel
          telemetry={telemetry}
          loading={loading}
          error={error}
          onRefresh={() => selectedCorridor && loadTelemetry(selectedCorridor)}
        />
      </aside>
      <main className="map-pane">
        <CorridorMap
          corridor={selectedCorridor}
          batteryDrainPercent={telemetry?.batteryDrainPercent}
          drawMode={drawMode}
          pendingStart={pendingStart}
          onDrawPoint={handleDrawPoint}
          simulateSignal={simulateSignal}
          simSpeed={simSpeed}
          onStatus={handleSimStatus}
          onTrafficUpdate={setTrafficStatus}
          onReroutingChange={setRerouting}
          tfrActive={tfrActive}
          onGeofenceStatus={setGeofenceStatus}
          refuelMode={refuelMode}
          refuelStop={refuelStop}
          onSetRefuelStop={handleSetRefuelStop}
        />
      </main>
    </div>
  );
}
