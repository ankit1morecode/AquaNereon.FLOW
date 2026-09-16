import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import * as THREE from 'three';
import { CHAMBER_IN_X, GEO, OUTLET_END_X } from '../config/geometry';
import { useVizStore, type ViewPreset } from '../store';

/**
 * Named viewpoints.
 *
 * The axial one earns its place: the whole claim of the assembly is that the
 * interaction writes a pattern around the circumference, and that pattern is
 * only a pattern when you are looking down the bore. From the side it is a
 * brightness gradient; from behind the ring it is the fingerprint itself,
 * laid over the water that produced it.
 */
export interface ViewDefinition {
  id: ViewPreset;
  label: string;
  hint: string;
  position: [number, number, number];
  target: [number, number, number];
}

export const VIEWS: ViewDefinition[] = [
  {
    id: 'overview',
    label: 'Overview',
    hint: 'The whole assembly, inlets to outlet',
    position: [-1.5, 5.6, 14.5],
    target: [1.6, 0, 0],
  },
  {
    id: 'junction',
    label: 'Junction',
    hint: 'Close on the chamber, where the two streams meet',
    position: [CHAMBER_IN_X - 1.2, 2.6, 6.2],
    target: [-0.3, 0, 0],
  },
  {
    id: 'ring',
    label: 'Sensor ring',
    hint: 'Down the bore at the ring — the fingerprint as a pattern, not a gradient',
    // Inside the bore, downstream of the ring, looking back up it — a
    // bore-scope. From outside the pipe end the flange frames the shot and the
    // ring is a small disc in the middle of it; from in here the ring fills
    // the view and the swirl comes straight at the lens, which is the whole
    // reason this view exists.
    position: [GEO.sensorRingX + 4.1, 0.2, 0.16],
    target: [GEO.sensorRingX - 0.3, 0, 0],
  },
  {
    id: 'outlet',
    label: 'Outlet',
    hint: 'The mixed flow leaving the junction',
    position: [OUTLET_END_X - 1.0, 2.4, 7.0],
    target: [OUTLET_END_X - 3.4, 0, 0],
  },
];

const VIEW_BY_ID = new Map(VIEWS.map((v) => [v.id, v]));

/** Seconds for a preset transition. */
const TRANSITION = 0.85;

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

/**
 * Drives the camera to the selected preset, then hands control back.
 *
 * A transition that fights the user is worse than no transition, so any
 * pointer interaction cancels the flight immediately and orbiting resumes
 * from wherever the camera had got to.
 */
export function CameraRig({ controls }: { controls: OrbitControlsImpl | null }) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const view = useVizStore((s) => s.view);

  const flight = useRef<{
    t: number;
    fromPos: THREE.Vector3;
    fromTarget: THREE.Vector3;
    toPos: THREE.Vector3;
    toTarget: THREE.Vector3;
  } | null>(null);

  // Start a flight whenever the preset changes.
  useEffect(() => {
    const def = VIEW_BY_ID.get(view);
    if (!def || !controls) return;
    flight.current = {
      t: 0,
      fromPos: camera.position.clone(),
      fromTarget: controls.target.clone(),
      toPos: new THREE.Vector3(...def.position),
      toTarget: new THREE.Vector3(...def.target),
    };
  }, [view, camera, controls]);

  // Any manual input wins.
  useEffect(() => {
    const cancel = () => {
      flight.current = null;
    };
    const el = gl.domElement;
    el.addEventListener('pointerdown', cancel);
    el.addEventListener('wheel', cancel, { passive: true });
    return () => {
      el.removeEventListener('pointerdown', cancel);
      el.removeEventListener('wheel', cancel);
    };
  }, [gl]);

  useFrame((_, delta) => {
    const f = flight.current;
    if (!f || !controls) return;

    f.t = Math.min(1, f.t + delta / TRANSITION);
    const e = easeInOut(f.t);

    camera.position.lerpVectors(f.fromPos, f.toPos, e);
    controls.target.lerpVectors(f.fromTarget, f.toTarget, e);
    controls.update();

    if (f.t >= 1) flight.current = null;
  });

  return null;
}
