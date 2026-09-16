import { create } from 'zustand';
import type { FlowState, JunctionCondition } from './core/types';
import { nearestQuality, suggestParticleCount, type QualityLevel } from './sim/SimulationEngine';

/**
 * UI-facing state.
 *
 * The simulation runs at display rate against mutable arrays; publishing every
 * frame through React would spend more time reconciling than simulating. The
 * scene pushes a snapshot here at a readable rate instead, and the panels
 * subscribe to that.
 */

export type SourceMode = 'NORMAL' | 'DRIFT' | 'DISTURBANCE' | 'MANUAL' | 'EXTERNAL';
export type ViewPreset = 'overview' | 'junction' | 'ring' | 'outlet';

export interface Readout {
  state: FlowState;
  baselineDistance: number;
  asymmetry: number;
  sectorImbalance: number;
  spatialGradient: number;
  swirlNumber: number;
  mode1: number;
  mode2: number;
  mode1Phase: number;
  axialDeficit: number;
  turbIntensity: number;
  flowA: number;
  flowB: number;
  outletVelocityMs: number;
  /** Rate of change of the baseline distance, per second. */
  distanceSlope: number;
  /** Fraction of the recent window spent at or above DRIFT. */
  persistence: number;
  /** Live channel distribution, copied out for the dial. */
  distribution: number[];
  baselineDistribution: number[];
  /** Position in the current dataset, seconds, and its length (0 = open-ended). */
  elapsed: number;
  duration: number;
}

export interface LayerToggles {
  streamlines: boolean;
  vortexCore: boolean;
  particles: boolean;
  labels: boolean;
}

export interface PanelToggles {
  metrics: boolean;
  fingerprint: boolean;
  waterfall: boolean;
  help: boolean;
}

interface VizStore {
  mode: SourceMode;
  view: ViewPreset;
  paused: boolean;
  timeScale: number;
  quality: QualityLevel;
  layers: LayerToggles;
  panels: PanelToggles;
  manual: { flowA: number; flowB: number; restriction: number; noiseLevel: number };
  readout: Readout;
  condition: JunctionCondition | null;
  /** Bumped to ask the scene to seek; carries the target time. */
  seekRequest: { time: number; nonce: number } | null;
  recording: { active: boolean; frames: number; seconds: number };

  setMode: (mode: SourceMode) => void;
  setView: (view: ViewPreset) => void;
  togglePaused: () => void;
  setPaused: (paused: boolean) => void;
  setTimeScale: (timeScale: number) => void;
  setQuality: (quality: QualityLevel) => void;
  toggleLayer: (layer: keyof LayerToggles) => void;
  togglePanel: (panel: keyof PanelToggles) => void;
  setManual: (patch: Partial<VizStore['manual']>) => void;
  requestSeek: (time: number) => void;
  clearSeek: () => void;
  setRecording: (recording: VizStore['recording']) => void;
  publish: (readout: Readout, condition: JunctionCondition) => void;
}

const emptyReadout: Readout = {
  state: 'STABLE',
  baselineDistance: 0,
  asymmetry: 0,
  sectorImbalance: 0,
  spatialGradient: 0,
  swirlNumber: 0,
  mode1: 0,
  mode2: 0,
  mode1Phase: 0,
  axialDeficit: 0,
  turbIntensity: 0,
  flowA: 0,
  flowB: 0,
  outletVelocityMs: 0,
  distanceSlope: 0,
  persistence: 0,
  distribution: [],
  baselineDistribution: [],
  elapsed: 0,
  duration: 0,
};

export const useVizStore = create<VizStore>((set) => ({
  mode: 'NORMAL',
  view: 'overview',
  paused: false,
  timeScale: 1,
  // Start on whatever budget the engine will actually be built with, so the
  // first render does not immediately rebuild the tracer population to a
  // different size than the one it was just given.
  quality: nearestQuality(suggestParticleCount()),
  layers: { streamlines: true, vortexCore: true, particles: true, labels: true },
  panels: { metrics: true, fingerprint: true, waterfall: true, help: false },
  manual: { flowA: 12, flowB: 12, restriction: 0, noiseLevel: 0.12 },
  readout: emptyReadout,
  condition: null,
  seekRequest: null,
  recording: { active: false, frames: 0, seconds: 0 },

  setMode: (mode) => set({ mode }),
  setView: (view) => set({ view }),
  togglePaused: () => set((s) => ({ paused: !s.paused })),
  setPaused: (paused) => set({ paused }),
  setTimeScale: (timeScale) => set({ timeScale }),
  setQuality: (quality) => set({ quality }),
  toggleLayer: (layer) =>
    set((s) => ({ layers: { ...s.layers, [layer]: !s.layers[layer] } })),
  togglePanel: (panel) =>
    set((s) => ({ panels: { ...s.panels, [panel]: !s.panels[panel] } })),
  setManual: (patch) => set((s) => ({ manual: { ...s.manual, ...patch } })),
  requestSeek: (time) =>
    set((s) => ({ seekRequest: { time, nonce: (s.seekRequest?.nonce ?? 0) + 1 } })),
  clearSeek: () => set({ seekRequest: null }),
  setRecording: (recording) => set({ recording }),
  publish: (readout, condition) => set({ readout, condition }),
}));

export const TIME_SCALES = [0.25, 0.5, 1, 2] as const;
