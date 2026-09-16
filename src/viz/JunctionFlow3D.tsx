import { useCallback, useEffect, useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import * as THREE from 'three';
import { GEO } from './config/geometry';
import type { FlowDataSource } from './core/types';
import { findScenario, SyntheticFlowSource } from './data/SyntheticFlowSource';
import { recordingToJson, type Recording } from './data/RecordedFlowSource';
import { CameraRig } from './scene/CameraRig';
import { Scene } from './scene/Scene';
import {
  QUALITY_LEVELS,
  SimulationEngine,
  suggestParticleCount,
} from './sim/SimulationEngine';
import { useVizStore } from './store';
import {
  CanvasErrorBoundary,
  ContextExhausted,
  ContextLostNotice,
  detectWebGL,
  useContextRecovery,
  WebGLUnavailable,
} from './ui/CanvasFallback';
import { ControlBar } from './ui/ControlBar';
import { FingerprintDial } from './ui/FingerprintDial';
import { FingerprintWaterfall } from './ui/FingerprintWaterfall';
import { HelpOverlay } from './ui/HelpOverlay';
import { StatePanel } from './ui/StatePanel';
import { useKeyboard } from './ui/useKeyboard';
import { ViewBar } from './ui/ViewBar';

/**
 * AquaNereon.FLOW — 3D physical flow visualization.
 *
 * Drop-in module. Pass a `source` to drive it from real telemetry; leave it
 * out and it replays the bundled synthetic scenarios.
 *
 *     <JunctionFlow3D source={liveNodeSource} />
 *
 * Scope note: this is a visualization of the physical sensing concept —
 * two flows interact, the interaction leaves a measurable pattern on the
 * circumference, and that pattern is the flow fingerprint. The velocity field
 * is phenomenological, built from named fluid-mechanics terms rather than
 * solved. It is not a CFD result and should not be presented as one.
 */

export interface JunctionFlow3DProps {
  /** External data source. Omit to replay the bundled synthetic dataset. */
  source?: FlowDataSource;
  /** Particle budget. Defaults to a value chosen from the machine's cores. */
  particleCount?: number;
  /** Hide the overlay panels, e.g. when embedding inside another screen. */
  chrome?: boolean;
  /** Bind keyboard shortcuts to the window. Off when embedding in a form-heavy page. */
  keyboard?: boolean;
  /** Called when a recording finishes. Defaults to downloading it as JSON. */
  onRecording?: (recording: Recording) => void;
  className?: string;
}

/** Offer a finished recording to the user as a file. */
function downloadRecording(recording: Recording): void {
  const blob = new Blob([recordingToJson(recording)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${recording.id}.json`;
  a.click();
  // Revoke on the next tick: revoking synchronously can beat the click.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function JunctionFlow3D({
  source,
  particleCount,
  chrome = true,
  keyboard = true,
  onRecording,
  className,
}: JunctionFlow3DProps) {
  const webgl = useMemo(detectWebGL, []);

  const [engine] = useState(() => {
    const initial = source ?? new SyntheticFlowSource(findScenario('NORMAL'));
    return new SimulationEngine(initial, {
      particleCount: particleCount ?? suggestParticleCount(),
      streamlineCount: 16,
    });
  });

  const [controls, setControls] = useState<OrbitControlsImpl | null>(null);
  const recovery = useContextRecovery();
  const setMode = useVizStore((s) => s.setMode);
  const panels = useVizStore((s) => s.panels);
  const setRecordingState = useVizStore((s) => s.setRecording);

  useKeyboard(keyboard && webgl.ok);

  // A host-supplied source takes over the mode selector entirely.
  useEffect(() => {
    if (source) setMode('EXTERNAL');
  }, [source, setMode]);

  // Dev handle, so the running simulation can be inspected from the console
  // without instrumenting the render path.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { aquaEngine?: SimulationEngine }).aquaEngine = engine;
  }, [engine]);

  const handleRecording = useCallback(
    (recording: Recording) => {
      setRecordingState({ active: false, frames: 0, seconds: 0 });
      (onRecording ?? downloadRecording)(recording);
    },
    [onRecording, setRecordingState],
  );

  if (!webgl.ok) {
    return (
      <div className={className ? `viz-root ${className}` : 'viz-root'}>
        <WebGLUnavailable reason={webgl.reason} />
      </div>
    );
  }

  if (recovery.exhausted) {
    return (
      <div className={className ? `viz-root ${className}` : 'viz-root'}>
        <ContextExhausted />
      </div>
    );
  }

  return (
    <div className={className ? `viz-root ${className}` : 'viz-root'}>
      <CanvasErrorBoundary>
        <Canvas
          key={recovery.generation}
          dpr={[1, 2]}
          camera={{ position: [-1.5, 5.6, 14.5], fov: 42, near: 0.1, far: 200 }}
          gl={{ antialias: true, alpha: false }}
          onCreated={({ gl, scene }) => {
            gl.setClearColor('#05090e');
            gl.toneMapping = THREE.ACESFilmicToneMapping;
            gl.toneMappingExposure = 1.15;
            scene.fog = new THREE.Fog('#05090e', 22, 52);
            // A context can arrive already lost when the browser has run out
            // of them; that never fires webglcontextlost, so check directly.
            recovery.attach(gl.domElement, gl.getContext().isContextLost());
          }}
        >
          <Scene
            engine={engine}
            externalSource={source}
            onRecordingComplete={handleRecording}
          />
          <OrbitControls
            ref={setControls}
            target={[1.6, 0, 0]}
            enableDamping
            dampingFactor={0.08}
            minDistance={2.5}
            maxDistance={48}
            maxPolarAngle={Math.PI * 0.94}
          />
          <CameraRig controls={controls} />
        </Canvas>
      </CanvasErrorBoundary>

      {recovery.lost && <ContextLostNotice />}

      {chrome && (
        <>
          <header className="viz-header">
            <h1>
              AquaNereon<span>.FLOW</span>
            </h1>
            <p>
              Hydraulic junction · {GEO.sensorChannels}-channel circumferential ring ·
              node <code>AN-J-014</code>
            </p>
          </header>

          {/* One rail down the left, so the measurement panels stack instead of
              colliding as they are toggled on and off. */}
          <div className="viz-left">
            <StatePanel />
            <div className="viz-left-bottom">
              {panels.fingerprint && <FingerprintDial />}
              {panels.waterfall && <FingerprintWaterfall engine={engine} />}
            </div>
          </div>

          <div className="viz-right">
            <ViewBar />
          </div>

          <div className="viz-bottom">
            <ControlBar externalLabel={source?.label} />
          </div>

          <footer className="viz-footer">
            Prototype visualization of the physical sensing concept. The velocity
            field is a phenomenological model, not a CFD solution.
            <button
              className="link"
              onClick={() => useVizStore.getState().togglePanel('help')}
            >
              What am I looking at?
            </button>
          </footer>

          <HelpOverlay />
        </>
      )}
    </div>
  );
}

export { QUALITY_LEVELS };
