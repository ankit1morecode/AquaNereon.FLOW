import type { EventId, WaterEvent } from '../../types';
import { SEVERITY_CLASS, STATE_CLASS, STATE_LABEL, relativeTime } from '../ui';

/**
 * Prioritised event list.
 *
 * Ordered by severity first and recency second, because an operator opening
 * this screen needs the worst thing currently happening, not the newest. Each
 * row states the transition that produced it — a disturbance that arrived from
 * drift is a different thing from one that arrived from stable — and whether
 * the event is local or propagated, which is the first question anyone asks.
 */

const SEVERITY_ORDER = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

const TYPE_LABEL: Record<WaterEvent['event_type'], string> = {
  FLOW_ANOMALY: 'Flow anomaly',
  LEAKAGE_SUSPECTED: 'Leakage suspected',
  PRESSURE_DISTURBANCE: 'Pressure disturbance',
  CONSUMPTION_SPIKE: 'Consumption spike',
  SHORTAGE_RISK: 'Shortage risk',
  SENSOR_FAULT: 'Sensor fault',
  NETWORK_EVENT: 'Network event',
};

export interface EventTimelineProps {
  events: WaterEvent[];
  selected?: EventId | null;
  onSelect?: (eventId: EventId) => void;
  /** Sort newest-first instead of by severity. */
  chronological?: boolean;
  limit?: number;
  emptyNote?: string;
}

export function EventTimeline({
  events,
  selected = null,
  onSelect,
  chronological = false,
  limit,
  emptyNote = 'No events. Every node is reading within its baseline.',
}: EventTimelineProps) {
  const sorted = [...events].sort((a, b) => {
    if (!chronological) {
      const open = Number(b.status !== 'CLOSED') - Number(a.status !== 'CLOSED');
      if (open !== 0) return open;
      const sev = SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity);
      if (sev !== 0) return sev;
    }
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
  });

  const shown = limit ? sorted.slice(0, limit) : sorted;

  if (shown.length === 0) return <div className="empty">{emptyNote}</div>;

  return (
    <ol className="event-timeline">
      {shown.map((event) => (
        <li key={event.event_id}>
          <button
            type="button"
            className={`event-row ${selected === event.event_id ? 'selected' : ''} ${
              event.status === 'CLOSED' ? 'closed' : ''
            }`}
            onClick={() => onSelect?.(event.event_id)}
          >
            <span className={`event-rail ${SEVERITY_CLASS[event.severity]}`} />

            <div className="event-main">
              <div className="event-line1">
                <strong>{TYPE_LABEL[event.event_type]}</strong>
                <span className={`event-sev ${SEVERITY_CLASS[event.severity]}`}>
                  {event.severity}
                </span>
                {event.network_context.propagation !== 'LOCAL' && (
                  <span className="event-prop">{event.network_context.propagation.toLowerCase()}</span>
                )}
              </div>

              <div className="event-line2">
                <code>{event.node_id}</code>
                <span className="event-arrow">
                  <i className={STATE_CLASS[event.state_transition.from]}>
                    {STATE_LABEL[event.state_transition.from]}
                  </i>
                  →
                  <i className={STATE_CLASS[event.state_transition.to]}>
                    {STATE_LABEL[event.state_transition.to]}
                  </i>
                </span>
              </div>
            </div>

            <div className="event-meta">
              <span className={`event-status status-${event.status.toLowerCase()}`}>
                {event.status.toLowerCase()}
              </span>
              <span className="event-time">{relativeTime(event.timestamp)}</span>
            </div>
          </button>
        </li>
      ))}
    </ol>
  );
}
