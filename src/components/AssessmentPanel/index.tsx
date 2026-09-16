import { useMemo } from 'react';
import { assess, type NeighbourState } from '../../services/assessment';
import type { FlowSignature, FlowState, NodeId } from '../../types';
import { Meter, Panel } from '../ui';

/**
 * Why the software currently believes what it believes about this node.
 *
 * Dossier §28 requires the node screen to carry the relevant AI model outputs
 * and an evidence panel, not only the state badge. Without them the screen
 * stops at a conclusion, which is the exact failure the dossier warns about
 * in §16 — no interface may report an assessment without the basis for it.
 *
 * Shown for every node, not only ones that have raised an event. A node
 * reading STABLE is also an assessment, and being able to see the evidence
 * that supports "nothing is wrong" is what makes the badge trustworthy the
 * rest of the time.
 *
 * The assessment is computed by the same function the event engine uses, so
 * this panel cannot disagree with the event it would produce.
 */

const KIND_LABEL: Record<string, string> = {
  SENSOR: 'Sensor',
  SIGNATURE_DEVIATION: 'Signature',
  BASELINE: 'Baseline',
  RATE_OF_CHANGE: 'Temporal',
  PERSISTENCE: 'Temporal',
  NEIGHBOUR: 'Network',
  MODEL: 'Model',
  DATA_QUALITY: 'Quality',
};

export interface AssessmentPanelProps {
  signature: FlowSignature;
  state: FlowState;
  upstream: NeighbourState[];
  downstream: NeighbourState[];
  nodeId: NodeId;
}

export function AssessmentPanel({
  signature,
  state,
  upstream,
  downstream,
  nodeId,
}: AssessmentPanelProps) {
  const assessment = useMemo(
    () => assess({ signature, state, upstream, downstream }),
    [signature, state, upstream, downstream],
  );

  return (
    <Panel
      title="Why this state"
      subtitle={
        state === 'STABLE'
          ? 'Live assessment — the evidence behind a clean reading'
          : 'Live assessment — the evidence behind the current classification'
      }
      className="assessment-panel"
    >
      <div className="ap-grid">
        <section>
          <h4>Evidence</h4>
          <ul className="ev-list">
            {assessment.evidence.map((item, i) => (
              <li key={i} title={item.detail}>
                <span className="ev-kind">{KIND_LABEL[item.kind] ?? item.kind}</span>
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
          {assessment.modelOutputs.map((model) => (
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

          <p className="ap-note">
            {assessment.propagated
              ? `Upstream nodes are also disturbed, so this reading is consistent with something arriving at ${nodeId} rather than starting there.`
              : `Nothing upstream of ${nodeId} is disturbed, so any deviation here appears to originate at or below it.`}
            {assessment.leakSuspected && downstream.length > 0 && (
              <>
                {' '}
                The pattern is one-sided and persistent, which points at the run
                towards <code>{downstream[0].node_id}</code> — indicative, not
                conclusive.
              </>
            )}
          </p>
        </section>
      </div>
    </Panel>
  );
}
