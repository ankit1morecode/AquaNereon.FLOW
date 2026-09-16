import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import * as THREE from 'three';
import { CHAMBER_IN_X, GEO, OUTLET_END_X } from '../config/geometry';
import { outletVelocityMs } from '../core/fieldParams';
import { PORT_A, PORT_B } from '../core/junctionPorts';
import type { FlowDataSource } from '../core/types';
import {
  findScenario,
  ManualFlowSource,
  SyntheticFlowSource,
} from '../data/SyntheticFlowSource';
import { FlowRecorder, type Recording } from '../data/RecordedFlowSource';
import { QUALITY_LEVELS, type SimulationEngine } from '../sim/SimulationEngine';
import { useVizStore } from '../store';
import { BreakdownMarker } from './BreakdownMarker';
import { JunctionAssembly } from './JunctionAssembly';
import { ParticleField } from './ParticleField';
import { SensorRing } from './SensorRing';
import { StreamlineLayer } from './StreamlineLayer';
import { VortexCore } from './VortexCore';
import { INLET_A_COLOR, INLET_B_COLOR } from './materials/particleMaterial';

/** How often the simulation pushes a snapshot to the React panels. */
const PUBLISH_HZ = 12;

function StationLabel({
  position,
  text,
  color = '#8fa6b8',
  size = 0.22,
}: {
  position: [number, number, number];
  text: string;
  color?: string;
  size?: number;
}) {
  return (
    <Text
      position={position}
      fontSize={size}
      color={color}
      anchorX="center"
      anchorY="middle"
      outlineWidth={0.012}
      outlineColor="#03070c"
      letterSpacing={0.12}
    >
      {text}
    </Text>
  );
}

export interface SceneProps {
  engine: SimulationEngine;
  /** Supplied by the host; overrides the scenario selector when present. */
  externalSource?: FlowDataSource;
  onRecordingComplete?: (recording: Recording) => void;
}

/**
 * Drives the engine and mirrors UI state into it.
 *
 * Everything that changes per frame happens here, in one place, in a fixed
 * order: step the simulation, then let the render components read what it
 * produced. Nothing downstream mutates the engine.
 */
function SimulationDriver({ engine, externalSource, onRecordingComplete }: SceneProps) {
  const mode = useVizStore((s) => s.mode);
  const paused = useVizStore((s) => s.paused);
  const timeScale = useVizStore((s) => s.timeScale);
  const quality = useVizStore((s) => s.quality);
  const manual = useVizStore((s) => s.manual);
  const seekRequest = useVizStore((s) => s.seekRequest);
  const recordingFlag = useVizStore((s) => s.recording.active);
  const publish = useVizStore((s) => s.publish);
  const clearSeek = useVizStore((s) => s.clearSeek);
  const setRecording = useVizStore((s) => s.setRecording);
  const setMode = useVizStore((s) => s.setMode);

  const manualSource = useMemo(() => new ManualFlowSource(), []);
  const recorder = useMemo(() => new FlowRecorder(10, 600), []);
  const publishAccum = useRef(0);

  // --- source selection ------------------------------------------------
  useEffect(() => {
    if (externalSource) {
      engine.setSource(externalSource);
      return;
    }
    if (mode === 'MANUAL') {
      engine.setSource(manualSource, false);
      return;
    }
    // EXTERNAL with no source to back it is stale state, not a mode. The store
    // is module-level, so a host that mounted this with a live feed leaves the
    // flag set; a later standalone mount would otherwise sit on a dead source
    // and render an empty pipe with no explanation.
    if (mode === 'EXTERNAL') {
      setMode('NORMAL');
      engine.setSource(new SyntheticFlowSource(findScenario('NORMAL')));
      return;
    }
    engine.setSource(new SyntheticFlowSource(findScenario(mode)));
  }, [engine, externalSource, manualSource, mode, setMode]);

  useEffect(() => {
    manualSource.flowA = manual.flowA;
    manualSource.flowB = manual.flowB;
    manualSource.restriction = manual.restriction;
    manualSource.noiseLevel = manual.noiseLevel;
  }, [manual, manualSource]);

  // --- playback --------------------------------------------------------
  useEffect(() => {
    engine.timeScale = timeScale;
  }, [engine, timeScale]);

  useEffect(() => {
    if (!seekRequest) return;
    engine.seek(seekRequest.time);
    clearSeek();
  }, [engine, seekRequest, clearSeek]);

  useEffect(() => {
    engine.setParticleCount(QUALITY_LEVELS[quality]);
  }, [engine, quality]);

  // --- recording -------------------------------------------------------
  useEffect(() => {
    if (recordingFlag) {
      recorder.start(engine.time);
      return;
    }
    if (!recorder.isRecording) return;
    const done = recorder.stop(`${engine.getSource().label} capture`);
    if (done) onRecordingComplete?.(done);
  }, [recordingFlag, recorder, engine, onRecordingComplete]);

  useFrame((_, delta) => {
    if (paused) return;
    engine.step(delta);

    if (recorder.isRecording) {
      recorder.capture(engine.condition, engine.time, delta * engine.timeScale);
    }

    publishAccum.current += delta;
    if (publishAccum.current < 1 / PUBLISH_HZ) return;
    publishAccum.current = 0;

    const s = engine.signature;
    const F = engine.field;
    const c = engine.condition;
    const source = engine.getSource();
    const duration = source.durationSec ?? 0;

    if (recorder.isRecording) {
      setRecording({
        active: true,
        frames: recorder.frameCount,
        seconds: recorder.elapsed,
      });
    }

    publish(
      {
        state: s.state,
        baselineDistance: s.baselineDistance,
        asymmetry: s.asymmetry,
        sectorImbalance: s.sectorImbalance,
        spatialGradient: s.spatialGradient,
        swirlNumber: F.swirlNumber,
        mode1: s.modes[0],
        mode2: s.modes[1],
        mode1Phase: s.mode1Phase,
        axialDeficit: F.axialDeficit,
        turbIntensity: F.turbIntensity,
        flowA: c.inletA.flowLps,
        flowB: c.inletB.flowLps,
        outletVelocityMs: outletVelocityMs(c),
        distanceSlope: engine.history.distanceSlope(4),
        persistence: engine.history.persistence(8),
        distribution: Array.from(s.distribution),
        baselineDistribution: Array.from(engine.baseline.distribution),
        elapsed: duration > 0 ? engine.time % duration : engine.time,
        duration,
      },
      c,
    );
  });

  return null;
}

export function Scene({ engine, externalSource, onRecordingComplete }: SceneProps) {
  const layers = useVizStore((s) => s.layers);
  const quality = useVizStore((s) => s.quality);

  const labelA = useMemo<[number, number, number]>(
    () => [PORT_A.origin.x - 0.2, PORT_A.origin.y + 1.05, PORT_A.origin.z],
    [],
  );
  const labelB = useMemo<[number, number, number]>(
    () => [PORT_B.origin.x - 0.2, PORT_B.origin.y - 1.05, PORT_B.origin.z],
    [],
  );

  return (
    <>
      <SimulationDriver
        engine={engine}
        externalSource={externalSource}
        onRecordingComplete={onRecordingComplete}
      />

      {/* --- lighting: dark instrument bay, no environment map to fetch --- */}
      <ambientLight intensity={0.28} color="#5d7c93" />
      <hemisphereLight args={['#4d7d99', '#0a1016', 0.5]} />
      <directionalLight position={[6, 9, 7]} intensity={1.15} color="#dff1ff" />
      <directionalLight position={[-8, -4, -6]} intensity={0.45} color="#3d6a8c" />
      <pointLight position={[0, 0, 0]} intensity={12} distance={7} color="#3fd0ff" />
      <pointLight
        position={[GEO.sensorRingX, 0, 0]}
        intensity={6}
        distance={4}
        color="#7fe0ff"
      />

      {/* --- hardware --- */}
      <JunctionAssembly />
      <SensorRing engine={engine} showLabels={layers.labels} />

      {/* --- fluid ---
          Keyed on the tracer budget: changing it replaces the whole particle
          system, and the renderer's buffer attributes point straight at that
          system's arrays. Without the key it would keep uploading the
          discarded ones and nothing would draw. */}
      {layers.particles && <ParticleField engine={engine} key={QUALITY_LEVELS[quality]} />}
      {layers.streamlines && <StreamlineLayer engine={engine} />}
      {layers.vortexCore && <VortexCore engine={engine} />}
      <BreakdownMarker engine={engine} />

      {/* --- station labels: one per station, staggered so none collide --- */}
      {layers.labels && (
        <>
          <StationLabel
            position={labelA}
            text="INLET A"
            color={`#${INLET_A_COLOR.getHexString()}`}
          />
          <StationLabel
            position={labelB}
            text="INLET B"
            color={`#${INLET_B_COLOR.getHexString()}`}
          />
          <StationLabel
            position={[CHAMBER_IN_X + 0.9, -GEO.junctionRadius - 0.9, 0]}
            text="JUNCTION · FLOWS INTERACT"
            size={0.2}
          />
          <StationLabel
            position={[GEO.sensorRingX + 0.2, GEO.pipeRadius + 1.9, 0]}
            text="SENSOR RING · 16 CH"
            color="#6fe0ff"
            size={0.21}
          />
          <StationLabel
            position={[OUTLET_END_X - 1.5, GEO.pipeRadius + 0.85, 0]}
            text="OUTLET"
          />
        </>
      )}

      {/* Faint ground plane for depth reference. Deliberately almost invisible:
          it should give the eye a horizon, not compete with the water. */}
      <gridHelper
        args={[70, 35, new THREE.Color('#0d222b'), new THREE.Color('#0a1920')]}
        position={[3, -5.2, 0]}
      />
    </>
  );
}
