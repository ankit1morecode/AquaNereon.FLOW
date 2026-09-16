import { VIEWS } from '../scene/CameraRig';
import { useVizStore } from '../store';

/**
 * Viewpoint and layer switches.
 *
 * Both sets are here because they answer the same question — what do I want to
 * be looking at — and separating them would mean hunting in two places to set
 * up one view.
 */
export function ViewBar() {
  const view = useVizStore((s) => s.view);
  const setView = useVizStore((s) => s.setView);
  const layers = useVizStore((s) => s.layers);
  const toggleLayer = useVizStore((s) => s.toggleLayer);
  const panels = useVizStore((s) => s.panels);
  const togglePanel = useVizStore((s) => s.togglePanel);

  return (
    <div className="view-bar">
      <div className="view-row" role="group" aria-label="Camera">
        {VIEWS.map((v, i) => (
          <button
            key={v.id}
            className={v.id === view ? 'view active' : 'view'}
            onClick={() => setView(v.id)}
            title={`${v.hint}  (${i + 1})`}
          >
            {v.label}
          </button>
        ))}
      </div>

      <div className="chip-row">
        <button
          className={layers.particles ? 'chip active' : 'chip'}
          onClick={() => toggleLayer('particles')}
          title="Tracer particles (P)"
        >
          Tracers
        </button>
        <button
          className={layers.streamlines ? 'chip active' : 'chip'}
          onClick={() => toggleLayer('streamlines')}
          title="Instantaneous streamlines (S)"
        >
          Streamlines
        </button>
        <button
          className={layers.vortexCore ? 'chip active' : 'chip'}
          onClick={() => toggleLayer('vortexCore')}
          title="Vortex core filament and envelope (V)"
        >
          Vortex
        </button>
        <button
          className={layers.labels ? 'chip active' : 'chip'}
          onClick={() => toggleLayer('labels')}
          title="Station and channel labels (L)"
        >
          Labels
        </button>
      </div>

      <div className="chip-row">
        <button
          className={panels.metrics ? 'chip active' : 'chip'}
          onClick={() => togglePanel('metrics')}
          title="State and measurement panel (M)"
        >
          Metrics
        </button>
        <button
          className={panels.fingerprint ? 'chip active' : 'chip'}
          onClick={() => togglePanel('fingerprint')}
          title="Fingerprint dial (F)"
        >
          Dial
        </button>
        <button
          className={panels.waterfall ? 'chip active' : 'chip'}
          onClick={() => togglePanel('waterfall')}
          title="Fingerprint over time (H)"
        >
          History
        </button>
        <button
          className={panels.help ? 'chip active' : 'chip'}
          onClick={() => togglePanel('help')}
          title="Keyboard shortcuts (?)"
        >
          ?
        </button>
      </div>
    </div>
  );
}
