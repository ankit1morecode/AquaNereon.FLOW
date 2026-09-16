import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { SimulationEngine } from '../sim/SimulationEngine';
import { INLET_A_COLOR, INLET_B_COLOR } from './materials/particleMaterial';

/**
 * Instantaneous streamlines, drawn as screen-space-width lines so they hold up
 * at any zoom.
 *
 * These carry the structure the particles only imply: where the spiral tightens,
 * where the two streams wrap around each other, and where a line stops advancing
 * altogether because it has run into the recirculation bubble.
 */
export function StreamlineLayer({
  engine,
  visible = true,
}: {
  engine: SimulationEngine;
  visible?: boolean;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const size = useThree((s) => s.size);

  const lines = useMemo(() => {
    return engine.streamlines.lines.map((line) => {
      const geometry = new LineGeometry();
      const material = new LineMaterial({
        color: (line.origin > 0.5 ? INLET_B_COLOR : INLET_A_COLOR).getHex(),
        linewidth: 1.4, // pixels
        transparent: true,
        opacity: 0.17,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        dashed: false,
      });
      const mesh = new Line2(geometry, material);
      mesh.renderOrder = 12;
      mesh.frustumCulled = false;
      mesh.visible = false;
      return { mesh, geometry, material, lastVersion: -1 };
    });
  }, [engine]);

  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    lines.forEach((l) => group.add(l.mesh));
    return () => {
      lines.forEach((l) => {
        group.remove(l.mesh);
        l.geometry.dispose();
        l.material.dispose();
      });
    };
  }, [lines]);

  // LineMaterial needs the viewport in pixels to keep a constant screen width.
  useEffect(() => {
    lines.forEach((l) => l.material.resolution.set(size.width, size.height));
  }, [lines, size]);

  useFrame(() => {
    if (!visible) return;
    // The engine re-integrates only a few lines per frame, and setPositions
    // rebuilds interleaved buffers, so push a line only when it actually
    // changed. Uploading all sixteen every frame costs more than the
    // integration does.
    for (let i = 0; i < lines.length; i++) {
      const src = engine.streamlines.lines[i];
      const dst = lines[i];
      if (dst.lastVersion === src.version) continue;
      dst.lastVersion = src.version;

      if (src.sampleCount < 2) {
        dst.mesh.visible = false;
        continue;
      }
      dst.geometry.setPositions(src.points.subarray(0, src.sampleCount * 3));
      dst.mesh.visible = true;
    }
  });

  return <group ref={groupRef} visible={visible} />;
}
