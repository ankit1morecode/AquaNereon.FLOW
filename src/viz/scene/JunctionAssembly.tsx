import { useMemo } from 'react';
import * as THREE from 'three';
import { CHAMBER_IN_X, CHAMBER_OUT_X, GEO, OUTLET_END_X } from '../config/geometry';
import { wallRadiusAt } from '../core/flowField';
import { PORTS } from '../core/junctionPorts';
import { createGlassMaterial, createMetalMaterial } from './materials/glassMaterial';

/**
 * The physical hardware: two inlet runs, the diagnostic chamber, the outlet
 * run, and the metal that holds them together.
 *
 * The chamber profile is lathed from the same wallRadiusAt() curve the flow
 * field uses to confine the water, so the bore drawn here and the bore the
 * fluid is solving inside are one surface by construction, not two sets of
 * numbers someone has to keep in agreement by hand.
 */

const RADIAL_SEGMENTS = 44;

/** Quaternion that rotates +Y (the axis of every cylinder here) onto `dir`. */
function alignY(dir: THREE.Vector3): THREE.Quaternion {
  return new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    dir.clone().normalize(),
  );
}

/**
 * One transparent shell drawn twice: back faces before the water (renderOrder
 * 0) and front faces after it (renderOrder 20). Without the split the shell
 * either hides the particles or floats in front of them.
 */
function GlassShell({
  geometry,
  position,
  quaternion,
}: {
  geometry: THREE.BufferGeometry;
  position?: [number, number, number];
  quaternion?: THREE.Quaternion;
}) {
  const back = useMemo(() => createGlassMaterial('back'), []);
  const front = useMemo(() => createGlassMaterial('front'), []);
  return (
    <>
      <mesh
        geometry={geometry}
        material={back}
        position={position}
        quaternion={quaternion}
        renderOrder={0}
      />
      <mesh
        geometry={geometry}
        material={front}
        position={position}
        quaternion={quaternion}
        renderOrder={20}
      />
    </>
  );
}

/**
 * Flange plate plus its bolt circle.
 *
 * The plate is an annulus, not a disc: a real pipe flange has the bore through
 * the middle of it. Beyond being correct, this is what lets the axial view
 * work at all — a solid plate on the end of the outlet would stand between the
 * camera and the sensor ring and there would be nothing to look at.
 */
function Flange({
  position,
  quaternion,
  radius,
}: {
  position: [number, number, number];
  quaternion: THREE.Quaternion;
  radius: number;
}) {
  const metal = useMemo(() => createMetalMaterial(0x8e9aa8, 0.38), []);
  const boltMetal = useMemo(() => createMetalMaterial(0x59636e, 0.55), []);
  const plate = useMemo(() => {
    const inner = radius + GEO.wallThickness;
    const outer = radius + 0.27;
    const h = 0.05;
    const profile = [
      new THREE.Vector2(inner, -h),
      new THREE.Vector2(outer, -h),
      new THREE.Vector2(outer, h),
      new THREE.Vector2(inner, h),
      new THREE.Vector2(inner, -h),
    ];
    const g = new THREE.LatheGeometry(profile, 40);
    g.computeVertexNormals();
    return g;
  }, [radius]);
  const bolt = useMemo(() => new THREE.CylinderGeometry(0.048, 0.048, 0.16, 8), []);

  const boltMatrices = useMemo(() => {
    const out: THREE.Matrix4[] = [];
    const n = 10;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      out.push(
        new THREE.Matrix4().setPosition(
          (radius + 0.17) * Math.cos(a),
          0,
          (radius + 0.17) * Math.sin(a),
        ),
      );
    }
    return out;
  }, [radius]);

  return (
    <group position={position} quaternion={quaternion}>
      <mesh geometry={plate} material={metal} />
      <instancedMesh
        args={[bolt, boltMetal, boltMatrices.length]}
        ref={(inst) => {
          if (!inst) return;
          boltMatrices.forEach((m, i) => inst.setMatrixAt(i, m));
          inst.instanceMatrix.needsUpdate = true;
        }}
      />
    </group>
  );
}

export function JunctionAssembly() {
  /** Chamber: lathed straight off the flow field's wall curve. */
  const chamber = useMemo(() => {
    const points: THREE.Vector2[] = [];
    const steps = 72;
    const x0 = CHAMBER_IN_X - 0.12;
    const x1 = CHAMBER_OUT_X + 0.5;
    for (let i = 0; i <= steps; i++) {
      const x = x0 + ((x1 - x0) * i) / steps;
      points.push(new THREE.Vector2(wallRadiusAt(x) + GEO.wallThickness * 0.5, x));
    }
    const g = new THREE.LatheGeometry(points, RADIAL_SEGMENTS);
    g.rotateZ(-Math.PI / 2); // lathe revolves about +Y; stand it along +X
    g.computeVertexNormals();
    return g;
  }, []);

  const inletLen = GEO.inletLength + 0.25;
  const inletGeom = useMemo(
    () =>
      new THREE.CylinderGeometry(
        GEO.pipeRadius + GEO.wallThickness,
        GEO.pipeRadius + GEO.wallThickness,
        inletLen,
        RADIAL_SEGMENTS,
        1,
        true,
      ),
    [inletLen],
  );

  const outletStart = CHAMBER_OUT_X + 0.3;
  const outletLen = OUTLET_END_X - outletStart;
  const outletGeom = useMemo(
    () =>
      new THREE.CylinderGeometry(
        GEO.pipeRadius + GEO.wallThickness,
        GEO.pipeRadius + GEO.wallThickness,
        outletLen,
        RADIAL_SEGMENTS,
        1,
        true,
      ),
    [outletLen],
  );

  const inlets = useMemo(
    () =>
      PORTS.map((port) => {
        const dir = new THREE.Vector3(port.direction.x, port.direction.y, port.direction.z);
        // Run backwards from the port, sunk slightly into the chamber face.
        const centre = new THREE.Vector3(port.position.x, port.position.y, port.position.z)
          .addScaledVector(dir, -(inletLen / 2 - 0.15));
        const tail = new THREE.Vector3(port.position.x, port.position.y, port.position.z)
          .addScaledVector(dir, -(inletLen - 0.2));
        return { port, dir, centre, tail, q: alignY(dir) };
      }),
    [inletLen],
  );

  const axisQ = useMemo(() => alignY(new THREE.Vector3(1, 0, 0)), []);

  return (
    <group>
      {/* ---- inlet runs ---- */}
      {inlets.map(({ port, centre, tail, q }) => (
        <group key={port.id}>
          <GlassShell
            geometry={inletGeom}
            position={[centre.x, centre.y, centre.z]}
            quaternion={q}
          />
          <Flange position={[tail.x, tail.y, tail.z]} quaternion={q} radius={GEO.pipeRadius} />
          <Flange
            position={[port.position.x, port.position.y, port.position.z]}
            quaternion={q}
            radius={GEO.pipeRadius}
          />
        </group>
      ))}

      {/* ---- junction chamber ---- */}
      <GlassShell geometry={chamber} />

      {/* Retaining band on the chamber body, so it reads as a housing. */}
      <mesh position={[0.1, 0, 0]} rotation={[0, Math.PI / 2, 0]}>
        <torusGeometry args={[GEO.junctionRadius + 0.06, 0.055, 10, 44]} />
        <meshStandardMaterial color="#7d8a98" metalness={0.85} roughness={0.42} />
      </mesh>

      {/* ---- outlet run ---- */}
      <GlassShell
        geometry={outletGeom}
        position={[outletStart + outletLen / 2, 0, 0]}
        quaternion={axisQ}
      />
      <Flange position={[outletStart + 0.15, 0, 0]} quaternion={axisQ} radius={GEO.pipeRadius} />
      <Flange position={[OUTLET_END_X - 0.12, 0, 0]} quaternion={axisQ} radius={GEO.pipeRadius} />
    </group>
  );
}
