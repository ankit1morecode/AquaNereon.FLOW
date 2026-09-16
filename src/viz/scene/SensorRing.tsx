import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import * as THREE from 'three';
import { GEO } from '../config/geometry';
import { CHANNEL_COUNT } from '../core/sensorRing';
import type { SimulationEngine } from '../sim/SimulationEngine';
import { createMetalMaterial } from './materials/glassMaterial';

/**
 * The circumferential sensor ring, mounted physically around the outlet pipe.
 *
 * Sixteen elements in a machined collar. Each element's emissive face tracks
 * its own channel reading, normalised against the ring mean, so the collar
 * itself displays the circumferential pattern: even glow when the flow is
 * balanced, one bright arc when the core has moved off axis, a scattered mess
 * when it has broken down.
 *
 * This is the moment the visualization is built around. Everything upstream
 * exists so that this ring has something to see.
 */

const RING_X = GEO.sensorRingX;
const COLLAR_INNER = GEO.pipeRadius + GEO.wallThickness + 0.02;
const COLLAR_OUTER = COLLAR_INNER + 0.3;
const POD_RADIUS = 0.085;

/** Colour ramp from cold (below mean) through neutral to hot (above mean). */
const COLD = new THREE.Color('#123a52');
const MID = new THREE.Color('#37d0f0');
const HOT = new THREE.Color('#ffd166');

export function SensorRing({
  engine,
  showLabels = true,
}: {
  engine: SimulationEngine;
  showLabels?: boolean;
}) {
  const podsRef = useRef<THREE.InstancedMesh>(null);
  const beamsRef = useRef<THREE.InstancedMesh>(null);

  const collarMaterial = useMemo(() => createMetalMaterial(0x69737e, 0.45), []);
  const podGeometry = useMemo(
    () => new THREE.CylinderGeometry(POD_RADIUS, POD_RADIUS * 0.78, 0.2, 12),
    [],
  );
  const podMaterial = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        emissive: 0xffffff,
        emissiveIntensity: 1.1,
        roughness: 0.35,
        metalness: 0.1,
        toneMapped: false,
      }),
    [],
  );

  /**
   * A short translucent wedge from each element towards the bore, so the
   * ring visibly looks at the sector it is reporting on rather than just
   * sitting next to it.
   */
  const beamGeometry = useMemo(
    () => new THREE.ConeGeometry(0.075, GEO.pipeRadius * 0.85, 10, 1, true),
    [],
  );
  const beamMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: 0x57e3ff,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    [],
  );

  /** Static placement: pods point outward, beams point inward. */
  const layout = useMemo(() => {
    const pods: THREE.Matrix4[] = [];
    const beams: THREE.Matrix4[] = [];
    const labelPositions: [number, number, number][] = [];
    const up = new THREE.Vector3(0, 1, 0);

    for (let i = 0; i < CHANNEL_COUNT; i++) {
      const a = (i / CHANNEL_COUNT) * Math.PI * 2;
      const outward = new THREE.Vector3(0, Math.cos(a), Math.sin(a));

      const qOut = new THREE.Quaternion().setFromUnitVectors(up, outward);
      const podPos = outward.clone().multiplyScalar(COLLAR_OUTER + 0.07);
      podPos.x = RING_X;
      pods.push(new THREE.Matrix4().compose(podPos, qOut, new THREE.Vector3(1, 1, 1)));

      // Cone geometry points +Y from its base; aim it inward at the bore.
      const qIn = new THREE.Quaternion().setFromUnitVectors(up, outward.clone().negate());
      const beamPos = outward.clone().multiplyScalar(GEO.pipeRadius * 0.55);
      beamPos.x = RING_X;
      beams.push(new THREE.Matrix4().compose(beamPos, qIn, new THREE.Vector3(1, 1, 1)));

      const label = outward.clone().multiplyScalar(COLLAR_OUTER + 0.33);
      labelPositions.push([RING_X + 0.26, label.y, label.z]);
    }
    return { pods, beams, labelPositions };
  }, []);

  /** Scratch objects, hoisted so the per-frame update allocates nothing. */
  const scratch = useMemo(
    () => ({
      color: new THREE.Color(),
      lit: new THREE.Color(),
      matrix: new THREE.Matrix4(),
      pos: new THREE.Vector3(),
      quat: new THREE.Quaternion(),
      scale: new THREE.Vector3(),
    }),
    [],
  );

  useFrame(() => {
    const pods = podsRef.current;
    const beams = beamsRef.current;
    if (!pods) return;

    const { channels, mean } = engine.signature;

    for (let i = 0; i < CHANNEL_COUNT; i++) {
      // Normalise against the ring mean: the pattern matters, not the level.
      const rel = mean > 1e-9 ? channels[i] / mean : 1;
      const t = THREE.MathUtils.clamp((rel - 0.7) / 0.6, 0, 1);

      if (t < 0.5) scratch.color.copy(COLD).lerp(MID, t * 2);
      else scratch.color.copy(MID).lerp(HOT, (t - 0.5) * 2);

      scratch.lit.copy(scratch.color).multiplyScalar(0.25 + 1.3 * t);
      pods.setColorAt(i, scratch.lit);

      if (beams) {
        // Beam length follows the reading, so the ring's view into the bore
        // reaches further where there is more momentum to see.
        layout.beams[i].decompose(scratch.pos, scratch.quat, scratch.scale);
        scratch.scale.set(1, 0.45 + 0.9 * t, 1);
        scratch.matrix.compose(scratch.pos, scratch.quat, scratch.scale);
        beams.setMatrixAt(i, scratch.matrix);
        beams.setColorAt(i, scratch.color);
      }
    }

    if (pods.instanceColor) pods.instanceColor.needsUpdate = true;
    if (beams) {
      beams.instanceMatrix.needsUpdate = true;
      if (beams.instanceColor) beams.instanceColor.needsUpdate = true;
    }
  });

  return (
    <group>
      {/* Machined collar body. */}
      <mesh position={[RING_X, 0, 0]} rotation={[0, 0, Math.PI / 2]} material={collarMaterial}>
        <cylinderGeometry args={[COLLAR_OUTER, COLLAR_OUTER, 0.34, 48, 1, true]} />
      </mesh>
      <mesh position={[RING_X, 0, 0]} rotation={[0, Math.PI / 2, 0]}>
        <torusGeometry args={[COLLAR_OUTER, 0.05, 10, 48]} />
        <meshStandardMaterial color="#8d99a6" metalness={0.9} roughness={0.35} />
      </mesh>
      <mesh position={[RING_X - 0.17, 0, 0]} rotation={[0, Math.PI / 2, 0]}>
        <torusGeometry args={[COLLAR_OUTER, 0.04, 10, 48]} />
        <meshStandardMaterial color="#5d6771" metalness={0.9} roughness={0.5} />
      </mesh>

      {/* Sensing elements. */}
      <instancedMesh
        ref={podsRef}
        args={[podGeometry, podMaterial, CHANNEL_COUNT]}
        renderOrder={22}
        onUpdate={(inst) => {
          layout.pods.forEach((m, i) => inst.setMatrixAt(i, m));
          inst.instanceMatrix.needsUpdate = true;
        }}
      />

      {/* Acceptance cones into the bore. */}
      <instancedMesh
        ref={beamsRef}
        args={[beamGeometry, beamMaterial, CHANNEL_COUNT]}
        renderOrder={11}
        frustumCulled={false}
        onUpdate={(inst) => {
          layout.beams.forEach((m, i) => inst.setMatrixAt(i, m));
          inst.instanceMatrix.needsUpdate = true;
        }}
      />

      {/* Channel numbers, so a reading on the dial can be tied to a pod on the
          hardware. Only legible from the axial view, which is the only view
          where knowing which channel is which matters. */}
      {showLabels &&
        layout.labelPositions.map((p, i) => (
          <Text
            key={i}
            position={p}
            fontSize={0.105}
            color="#93b4c6"
            anchorX="center"
            anchorY="middle"
            outlineWidth={0.008}
            outlineColor="#03070c"
          >
            {String(i + 1).padStart(2, '0')}
          </Text>
        ))}
    </group>
  );
}
