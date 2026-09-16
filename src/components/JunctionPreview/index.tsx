import { Suspense, lazy } from 'react';
import type { FlowSignature, NodeSummary } from '../../types';
import { LiveSensorSource } from '../../viz/data/LiveSensorSource';
import { useMemo, useEffect } from 'react';

/**
 * A live 3D junction, driven by a node's telemetry.
 *
 * The bridge between the platform and the physical visualization: it takes the
 * branch flows a node is reporting and pushes them into the 3D module's own
 * data seam, so the water in the viewport is the water the signature on the
 * same page was computed from.
 *
 * Loaded lazily. Three.js is by far the largest thing in the bundle, and the
 * City, Zone, Events and Reports screens have no use for it — there is no
 * reason to make an operator download a renderer to look at an event list.
 */

const JunctionFlow3D = lazy(async () => {
  const module = await import('../../viz');
  return { default: module.JunctionFlow3D };
});

export interface JunctionPreviewProps {
  node: NodeSummary;
  signature: FlowSignature;
  /** Hide the 3D module's own overlay panels; the page supplies its own. */
  chrome?: boolean;
  /** Bind the module's keyboard shortcuts. Off inside a page with its own. */
  keyboard?: boolean;
  height?: number | string;
}

export function JunctionPreview({
  node,
  signature,
  chrome = true,
  keyboard = false,
  height = 420,
}: JunctionPreviewProps) {
  // One source per node, so switching nodes rebuilds the feed rather than
  // splicing one node's conditions into another's history.
  const source = useMemo(
    () => new LiveSensorSource(node.location.label, 30),
    [node.node_id, node.location.label],
  );

  // Push every new telemetry frame into the visualization's data seam. This is
  // the same path a real MQTT relay would use; nothing in the 3D module knows
  // the difference.
  useEffect(() => {
    const hydraulic = signature.hydraulic;
    const total = hydraulic.flow_mean;
    const spread = hydraulic.flow_variation;
    const a = (total + spread) / 2;
    const b = (total - spread) / 2;

    // Which branch is the strong one is carried by the circumferential phase:
    // the pattern leans toward whichever branch is delivering more.
    const leanToA = Math.cos(signature.circumferential.mode1_phase) >= 0;

    source.push(
      {
        t: 0,
        inletA: {
          flowLps: leanToA ? a : b,
          pressureKpa: hydraulic.pressure_mean + hydraulic.pressure_variation / 2,
          temperatureC: signature.water_properties.temperature,
        },
        inletB: {
          flowLps: leanToA ? b : a,
          pressureKpa: hydraulic.pressure_mean - hydraulic.pressure_variation / 2,
          temperatureC: signature.water_properties.temperature,
        },
        // Recover the restriction the deficit implies, so a broken-down core on
        // the platform side shows as a broken-down core in the viewport.
        downstreamRestriction: Math.max(
          0,
          Math.min(0.8, (hydraulic.axial_deficit - 0.25) / 2.2),
        ),
        noiseLevel: Math.max(0.05, 1 - signature.data_quality.confidence),
      },
      performance.now() / 1000,
    );
  }, [source, signature]);

  return (
    <div className="junction-preview" style={{ height }}>
      <Suspense
        fallback={
          <div className="empty">
            <span className="spinner" /> Loading 3D view…
          </div>
        }
      >
        <JunctionFlow3D source={source} chrome={chrome} keyboard={keyboard} />
      </Suspense>
    </div>
  );
}
