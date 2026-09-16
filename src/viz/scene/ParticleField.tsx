import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { SimulationEngine } from '../sim/SimulationEngine';
import { createParticleMaterial } from './materials/particleMaterial';

/**
 * Draws the tracer particles the simulation advects.
 *
 * The engine owns the arrays; this component only wraps them in buffer
 * attributes and marks them dirty once per frame. Nothing is copied.
 */
export function ParticleField({ engine }: { engine: SimulationEngine }) {
  const pointsRef = useRef<THREE.Points>(null);
  const material = useMemo(() => createParticleMaterial(), []);
  const gl = useThree((s) => s.gl);

  const size = useThree((s) => s.size);

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const { positions, velocities, speeds, origins, alphas } = engine.particles.buffers;
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('aVelocity', new THREE.BufferAttribute(velocities, 3));
    g.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1));
    g.setAttribute('aOrigin', new THREE.BufferAttribute(origins, 1));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
    // The pipes are a fixed volume; skipping the per-frame bounds recompute
    // saves a full pass over the position array.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 24);
    g.computeBoundingSphere = () => {};
    return g;
  }, [engine]);

  // The streak shader works in device pixels, so it needs the drawing buffer
  // size, not the CSS size.
  useEffect(() => {
    const dpr = Math.min(gl.getPixelRatio(), 2);
    material.uniforms.uPixelRatio.value = dpr;
    material.uniforms.uResolution.value.set(size.width * dpr, size.height * dpr);
  }, [gl, material, size]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  useFrame(() => {
    const g = pointsRef.current?.geometry;
    if (!g) return;
    (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('aVelocity') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('aSpeed') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('aOrigin') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('aAlpha') as THREE.BufferAttribute).needsUpdate = true;
  });

  return (
    <points ref={pointsRef} geometry={geometry} material={material} renderOrder={10} frustumCulled={false} />
  );
}
