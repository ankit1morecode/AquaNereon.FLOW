import { STATE_THRESHOLDS } from '../core/baseline';
import type { FlowState } from '../core/types';
import { useVizStore } from '../store';

/**
 * State badge and the handful of numbers the state was derived from.
 *
 * Deliberately not a dashboard. Every value shown here is either an input to
 * the classification or the classification itself, so a viewer can check the
 * chain rather than take it on trust: the ring pattern moved this far from
 * baseline, which is why the badge says what it says.
 */

const ALL_STATES: FlowState[] = ['STABLE', 'DRIFT', 'PRE_DISTURBANCE', 'DISTURBANCE'];

const STATE_LABEL: Record<FlowState, string> = {
  STABLE: 'Stable',
  DRIFT: 'Drift',
  PRE_DISTURBANCE: 'Pre-disturbance',
  DISTURBANCE: 'Disturbance',
};

function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="metric" title={hint}>
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value}</span>
    </div>
  );
}

export function StatePanel() {
  const r = useVizStore((s) => s.readout);
  const visible = useVizStore((s) => s.panels.metrics);
  if (!visible) return null;

  // Where the current distance sits on the classifier's scale.
  const span = STATE_THRESHOLDS.disturbance * 1.6;
  const pct = Math.min(100, (r.baselineDistance / span) * 100);

  return (
    <div className="state-panel">
      {/* All four labels occupy one grid cell so the badge is always as wide
          as the longest. A badge that grows from "Stable" to "Pre-disturbance"
          shoves the panel around it every time the flow escalates. */}
      <div className={`badge state-${r.state.toLowerCase()}`}>
        <span className="badge-dot" />
        <span className="badge-labels">
          {ALL_STATES.map((s) => (
            <span key={s} className={s === r.state ? 'on' : ''} aria-hidden={s !== r.state}>
              {STATE_LABEL[s]}
            </span>
          ))}
        </span>
      </div>

      <div className="distance">
        <div className="distance-track">
          <span
            className="distance-edge"
            style={{ left: `${(STATE_THRESHOLDS.drift / span) * 100}%` }}
          />
          <span
            className="distance-edge"
            style={{ left: `${(STATE_THRESHOLDS.preDisturbance / span) * 100}%` }}
          />
          <span
            className="distance-edge"
            style={{ left: `${(STATE_THRESHOLDS.disturbance / span) * 100}%` }}
          />
          <span className="distance-fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="distance-label">
          baseline distance {r.baselineDistance.toFixed(3)}
        </span>
      </div>

      <div className="metrics">
        <Metric
          label="Asymmetry"
          value={r.asymmetry.toFixed(3)}
          hint="Resultant of the 16 channel vectors. Zero when the ring reads evenly all the way round."
        />
        <Metric
          label="Sector imbalance"
          value={r.sectorImbalance.toFixed(2)}
          hint="(max - min) / mean across the ring."
        />
        <Metric
          label="Mode 1"
          value={r.mode1.toFixed(3)}
          hint="First circumferential Fourier mode: the vortex core sitting off axis."
        />
        <Metric
          label="Mode 2"
          value={r.mode2.toFixed(3)}
          hint="Second mode: elliptic deformation of the flow pattern."
        />
        <Metric
          label="Swirl number"
          value={r.swirlNumber.toFixed(2)}
          hint="Angular momentum flux / (outlet radius x axial momentum flux)."
        />
        <Metric
          label="Core deficit"
          value={r.axialDeficit.toFixed(2)}
          hint="Axial velocity deficit on the vortex core. Above 1.0 the core recirculates."
        />
        <Metric
          label="Rate of change"
          value={`${r.distanceSlope >= 0 ? '+' : ''}${(r.distanceSlope * 1000).toFixed(1)}`}
          hint="Change in baseline distance per second, x1000. Separates a junction still moving away from its baseline from one that has settled somewhere new."
        />
        <Metric
          label="Persistence"
          value={`${Math.round(r.persistence * 100)}%`}
          hint="Fraction of the last 8 seconds spent at or above DRIFT. Separates a transient from a developing condition."
        />
      </div>

      <div className="flows">
        <span className="flow flow-a">
          A <strong>{r.flowA.toFixed(1)}</strong> L/s
        </span>
        <span className="flow flow-b">
          B <strong>{r.flowB.toFixed(1)}</strong> L/s
        </span>
        <span className="flow flow-out">
          out <strong>{r.outletVelocityMs.toFixed(2)}</strong> m/s
        </span>
      </div>
    </div>
  );
}
