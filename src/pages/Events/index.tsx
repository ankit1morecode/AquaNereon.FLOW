import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useApi, useQuery, usePlatform } from '../../services/ApiProvider';
import { EventTimeline } from '../../components/EventTimeline';
import { EvidencePanel } from '../../components/EvidencePanel';
import { NetworkMap } from '../../components/NetworkMap';
import { Empty, ErrorNote, Loading, Panel } from '../../components/ui';
import type { Severity, WaterEvent } from '../../types';

/**
 * Event Center.
 *
 * A prioritised list on the left and the full evidence chain on the right. The
 * split is the point: no event can be acted on from the list alone, and
 * selecting one always shows why it exists before offering anything to do
 * about it.
 */

const SEVERITIES: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
const STATUSES: WaterEvent['status'][] = [
  'OPEN',
  'ACKNOWLEDGED',
  'INTERVENING',
  'VERIFYING',
  'CLOSED',
];

export function Events() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const platform = usePlatform();
  const client = useApi();

  const [severity, setSeverity] = useState<Severity | null>(null);
  const [status, setStatus] = useState<WaterEvent['status'] | null>(null);

  const events = useQuery((c) => c.getEvents({ limit: 80 }), []);
  const recommendations = useQuery((c) => c.getRecommendations(), []);
  const network = useQuery((c) => c.getNetwork(), []);
  const nodes = useQuery((c) => c.getNodes(), []);

  const selectedId = params.get('event');

  const filtered = useMemo(() => {
    let items = events.data?.items ?? [];
    if (severity) items = items.filter((e) => e.severity === severity);
    if (status) items = items.filter((e) => e.status === status);
    return items;
  }, [events.data, severity, status]);

  const selected =
    (events.data?.items ?? []).find((e) => e.event_id === selectedId) ?? filtered[0] ?? null;

  const setStatusFor = async (event: WaterEvent, next: WaterEvent['status']) => {
    // The simulator owns event state; a real backend would take a PATCH. Both
    // go through the client so the page never reaches past its own boundary.
    if (platform) {
      platform.setEventStatus(event.event_id, next);
    } else {
      await client.postEvent({ ...event, status: next });
    }
  };

  if (events.error) return <ErrorNote error={events.error} />;
  if (!events.data) return <Loading what="events" />;

  const openCount = (events.data.items ?? []).filter((e) => e.status !== 'CLOSED').length;

  return (
    <div className="page events-page">
      <div className="ep-list">
        <Panel
          title="Events"
          subtitle={`${openCount} open of ${events.data.total}`}
          actions={
            <div className="ep-filters">
              <select
                value={severity ?? ''}
                onChange={(e) => setSeverity((e.target.value || null) as Severity | null)}
                aria-label="Filter by severity"
              >
                <option value="">all severities</option>
                {SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {s.toLowerCase()}
                  </option>
                ))}
              </select>
              <select
                value={status ?? ''}
                onChange={(e) =>
                  setStatus((e.target.value || null) as WaterEvent['status'] | null)
                }
                aria-label="Filter by status"
              >
                <option value="">all statuses</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s.toLowerCase()}
                  </option>
                ))}
              </select>
            </div>
          }
          scroll
        >
          <EventTimeline
            events={filtered}
            selected={selected?.event_id ?? null}
            onSelect={(id) => setParams({ event: id })}
            emptyNote={
              severity || status
                ? 'No events match this filter.'
                : 'No events. Every node is reading within its baseline.'
            }
          />
        </Panel>
      </div>

      <div className="ep-detail">
        {selected && network.data && nodes.data && (
          <Panel
            title="Where"
            subtitle={
              selected.network_context.propagation === 'LOCAL'
                ? 'Local to this node — nothing upstream explains it'
                : 'Traced back through its disturbed feeders'
            }
            className="map-panel ep-map"
          >
            <NetworkMap
              network={network.data}
              nodes={nodes.data}
              events={events.data.items}
              selected={selected.node_id}
              focusEvent={selected}
              followEvent
              onSelect={(id) => navigate(`/nodes/${id}`)}
              height="100%"
            />
          </Panel>
        )}

        {selected ? (
          <Panel title="Why this event exists" subtitle="Evidence chain, model outputs and context">
            <EvidencePanel
              event={selected}
              onStatusChange={(next) => void setStatusFor(selected, next)}
            />
          </Panel>
        ) : (
          <Panel title="Evidence">
            <Empty>Select an event to see the evidence it was formed from.</Empty>
          </Panel>
        )}

        <Panel title="Recommendations" subtitle="Derived from open events" scroll>
          {(recommendations.data ?? []).length === 0 ? (
            <Empty>No recommendations outstanding.</Empty>
          ) : (
            <ul className="rec-list">
              {(recommendations.data ?? []).slice(0, 8).map((rec) => (
                <li key={rec.recommendation_id}>
                  <div className="rec-head">
                    <span className={`rec-prio p${rec.priority}`}>P{rec.priority}</span>
                    <code>{rec.node_id ?? rec.zone_id}</code>
                    <span className="rec-status">{rec.status.toLowerCase()}</span>
                  </div>
                  <p className="rec-action">{rec.action}</p>
                  <p className="rec-why">{rec.rationale}</p>
                  <p className="rec-verify">
                    <strong>Verify:</strong> {rec.verification}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
