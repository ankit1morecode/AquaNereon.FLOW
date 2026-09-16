/**
 * Public surface of the 3D flow visualization module.
 *
 * Importing anything below this line from outside the module is a sign the
 * boundary has slipped.
 */

export { JunctionFlow3D } from './JunctionFlow3D';
export type { JunctionFlow3DProps } from './JunctionFlow3D';

// The data seam: implement FlowDataSource to feed the scene from real hardware.
export type {
  FlowDataSource,
  JunctionCondition,
  InletCondition,
  FlowSignature,
  CircumferentialFrame,
  FlowState,
} from './core/types';

export {
  SyntheticFlowSource,
  ManualFlowSource,
  SCENARIOS,
  findScenario,
  BASELINE_CONDITION,
} from './data/SyntheticFlowSource';
export type { ScenarioDataset } from './data/SyntheticFlowSource';

export {
  LiveSensorSource,
  WebSocketFlowSource,
  defaultTelemetryMapper,
} from './data/LiveSensorSource';
export type {
  TelemetryMapper,
  ConnectionState,
  WebSocketFlowSourceOptions,
} from './data/LiveSensorSource';

export {
  RecordedFlowSource,
  FlowRecorder,
  recordingToJson,
  recordingFromJson,
} from './data/RecordedFlowSource';
export type { Recording, RecordedFrame } from './data/RecordedFlowSource';

// Headless measurement chain, for tests, tooling or a server-side check.
export { deriveFieldParams, outletVelocityMs, outletReynolds } from './core/fieldParams';
export { sampleVelocity, confine, wallRadiusAt, coreCenterAt } from './core/flowField';
export { sampleRing, analyseRing, distributionDistance, CHANNEL_COUNT } from './core/sensorRing';
export {
  captureBaseline,
  buildSignature,
  scoreFrame,
  classify,
  applyHysteresis,
  STATE_THRESHOLDS,
  PERSISTENCE_TAU,
} from './core/baseline';
export type { Baseline } from './core/baseline';

export { SimulationEngine, QUALITY_LEVELS, suggestParticleCount } from './sim/SimulationEngine';
export type { QualityLevel, SimulationOptions } from './sim/SimulationEngine';
export { SignatureHistory, HISTORY_HZ, HISTORY_SECONDS } from './sim/SignatureHistory';

export { useVizStore } from './store';
export type { SourceMode, ViewPreset, Readout } from './store';
