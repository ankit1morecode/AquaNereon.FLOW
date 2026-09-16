import { Link } from 'react-router-dom';
import type { EvidenceItem, WaterEvent } from '../../types';
import { Meter, STATE_CLASS, STATE_LABEL, relativeTime } from '../ui';

/**
 * Why this event exists.
 *
 * The dossier's hardest rule about the UI is that it must never say "AI
 * detected leakage" and stop there (§16, §28). So this panel answers the nine
 * questions the dossier lists, in order, from the evidence the event actually
 * carries: what changed, where, when, how far from baseline, how fast, whether
 * it persisted, what the neighbours did, which models agreed, and how good the
 * data was.
 *
 * Each evidence item shows its weight, so a conclusion resting on one strong
 * signal looks different from one resting on six weak ones.
 */

const KIND_LABEL: Record<EvidenceItem['kind'], string> = {
  SENSOR: 'Sensor',
  SIGNATURE_DEVIATION: 'Signature',
  BASELINE: 'Baseline',
  RATE_OF_CHANGE: 'Temporal',
  PERSISTENCE: 'Temporal',
  NEIGHBOUR: 'Network',
  MODEL: 'Model',
  DATA_QUALITY: 'Quality',
};

export interface EvidencePanelProps {
  event: WaterEvent;
  onStatusChange?: (status: WaterEvent['status']) => void;
}

export function EvidencePanel({ event, onStatusChange }: EvidencePanelProps) {
  const quality = event.data_quality;

  return (
    <div className="evidence-panel">
      <header className="ev-head">
        <div>
          <h3>{event.event_id}</h3>
          <p>
            <Link to={`/nodes/${event.node_id}`}>
              <code>{event.node_id}</code>
            </Link>{' '}
            · zone {event.zone_id} · {relativeTime(event.timestamp)}
          </p>
        </div>
        <span className="ev-score" title="Anomaly score, 0–1">
          {event.anomaly_score.toFixed(2)}
        </span>
      </header>

      <div className="ev-transition">
        <i className={STATE_CLASS[event.state_transition.from]}>
          {STATE_LABEL[event.state_transition.from]}
        </i>
        <span>→</span>
        <i className={STATE_CLASS[event.state_transition.to]}>
          {STATE_LABEL[event.state_transition.to]}
        </i>
        <span className="ev-prop">{event.network_context.propagation.toLowerCase()}</span>
      </div>

      <section>
        <h4>Evidence</h4>
        <ul className="ev-list">
          {event.evidence.map((item, i) => (
            <li key={i} title={item.detail}>
              <span className="ev-kind">{KIND_LABEL[item.kind]}</span>
              <span className="ev-label">{item.label}</span>
              <span className="ev-value">{item.value}</span>
              <span className="ev-weight">
                <Meter
                  value={item.weight}
                  tone={item.weight > 0.66 ? 'hot' : item.weight > 0.33 ? 'warn' : 'a'}
                  label={`Contribution ${Math.round(item.weight * 100)}%`}
                />
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h4>Model outputs</h4>
        {event.model_outputs.map((model) => (
          <article key={model.model_id} className="ev-model">
            <div className="ev-model-head">
              <code>{model.model_id}</code>
              <span className="ev-model-version">v{model.model_version}</span>
              <span className="ev-model-score">
                score {model.score.toFixed(2)} · confidence {model.confidence.toFixed(2)}
              </span>
            </div>
            <p className="ev-model-pred">{model.prediction}</p>
            <ul className="ev-explain">
              {model.explanation.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
            <p className="ev-features">
              {model.contributing_features.map((f) => (
                <code key={f}>{f}</code>
              ))}
            </p>
          </article>
        ))}
      </section>

      <section>
        <h4>Network context</h4>
        <div className="ev-neighbours">
          <div>
            <span className="ev-nb-label">Upstream</span>
            {event.network_context.upstream_states.length === 0 ? (
              <em>none</em>
            ) : (
              event.network_context.upstream_states.map((n) => (
                <span key={n.node_id} className={STATE_CLASS[n.state]}>
                  {n.node_id} · {STATE_LABEL[n.state]}
                </span>
              ))
            )}
          </div>
          <div>
            <span className="ev-nb-label">Downstream</span>
            {event.network_context.downstream_states.length === 0 ? (
              <em>none</em>
            ) : (
              event.network_context.downstream_states.map((n) => (
                <span key={n.node_id} className={STATE_CLASS[n.state]}>
                  {n.node_id} · {STATE_LABEL[n.state]}
                </span>
              ))
            )}
          </div>
        </div>
      </section>

      {event.suspected_origin && (
        <section>
          <h4>Suspected origin</h4>
          <p className="ev-origin">
            {event.suspected_origin.description}
            <span>confidence {event.suspected_origin.confidence.toFixed(2)}</span>
          </p>
        </section>
      )}

      {event.recommended_action && (
        <section>
          <h4>Recommended action</h4>
          <p className="ev-action">{event.recommended_action.action}</p>
          <p className="ev-rationale">{event.recommended_action.rationale}</p>
        </section>
      )}

      <section>
        <h4>Data quality</h4>
        <div className="ev-quality">
          <span>completeness {Math.round(quality.completeness * 100)}%</span>
          <span>confidence {Math.round(quality.confidence * 100)}%</span>
          {quality.stale && <span className="ev-stale">feed stale</span>}
          {quality.suspect_channels.length > 0 && (
            <span className="ev-stale">
              suspect channels {quality.suspect_channels.join(', ')}
            </span>
          )}
        </div>
      </section>

      {onStatusChange && (
        <footer className="ev-actions">
          {(['ACKNOWLEDGED', 'INTERVENING', 'VERIFYING', 'CLOSED'] as const).map((status) => (
            <button
              key={status}
              type="button"
              className={event.status === status ? 'btn active' : 'btn'}
              onClick={() => onStatusChange(status)}
              disabled={event.status === status}
            >
              {status.toLowerCase()}
            </button>
          ))}
        </footer>
      )}
    </div>
  );
}
