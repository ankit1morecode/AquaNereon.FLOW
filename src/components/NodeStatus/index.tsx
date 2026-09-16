import { Link } from 'react-router-dom';
import type { FlowSignature, NodeSummary } from '../../types';
import { Sparkline } from '../charts';
import { HealthDot, StateBadge, relativeTime } from '../ui';

/**
 * One node, at a glance.
 *
 * Carries the four things an operator needs before deciding whether to open
 * it: what state it is in, whether the hardware is healthy, how far it has
 * moved from baseline recently, and whether the software has already raised
 * its own sampling in response. That last one matters — a node in
 * high-resolution mode is one the system is already unsure about.
 */

export interface NodeStatusProps {
  node: NodeSummary;
  /** Recent signatures, for the deviation sparkline. */
  history?: FlowSignature[];
  selected?: boolean;
  onSelect?: (nodeId: string) => void;
  /** Render as a link to the diagnostics page instead of a button. */
  asLink?: boolean;
  compact?: boolean;
}

export function NodeStatus({
  node,
  history = [],
  selected = false,
  onSelect,
  asLink = false,
  compact = false,
}: NodeStatusProps) {
  const trace = history.map((s) => s.baseline_distance);
  const loadPct = Math.round((node.flow_lps / Math.max(node.nominal_flow_lps, 1)) * 100);
  const adaptive = node.sampling_mode !== 'NORMAL';

  const body = (
    <>
      <div className="ns-head">
        <div className="ns-ident">
          <HealthDot health={node.health} />
          <strong>{node.node_id}</strong>
          <span className="ns-place">{node.location.label}</span>
        </div>
        <StateBadge state={node.state} size="sm" />
      </div>

      {!compact && (
        <>
          <div className="ns-figures">
            <span>
              <b>{node.flow_lps.toFixed(1)}</b>
              <em>L/s</em>
            </span>
            <span className={loadPct > 115 ? 'warn' : undefined}>
              <b>{loadPct}</b>
              <em>% of nominal</em>
            </span>
            <span>
              <b>{node.anomaly_score.toFixed(2)}</b>
              <em>anomaly</em>
            </span>
          </div>

          {trace.length > 1 && (
            <Sparkline
              values={trace}
              color={
                node.state === 'STABLE'
                  ? 'var(--state-stable)'
                  : node.state === 'DRIFT'
                    ? 'var(--state-drift)'
                    : node.state === 'PRE_DISTURBANCE'
                      ? 'var(--state-pre)'
                      : 'var(--state-disturbance)'
              }
            />
          )}
        </>
      )}

      <div className="ns-foot">
        <span className={adaptive ? 'ns-sampling active' : 'ns-sampling'}>
          {adaptive ? '◉' : '○'} {node.sampling_mode.replace('_', '-').toLowerCase()}
        </span>
        <span className="ns-seen">{relativeTime(node.last_seen)}</span>
      </div>
    </>
  );

  const className = `node-status ${selected ? 'selected' : ''} ${compact ? 'compact' : ''}`;

  if (asLink) {
    return (
      <Link className={className} to={`/nodes/${node.node_id}`}>
        {body}
      </Link>
    );
  }

  return (
    <button type="button" className={className} onClick={() => onSelect?.(node.node_id)}>
      {body}
    </button>
  );
}
