import { useNavigate } from 'react-router-dom';
import { useMemo } from 'react';
import { useQuery } from '../../services/ApiProvider';
import { NetworkMap } from '../../components/NetworkMap';
import { NodeStatus } from '../../components/NodeStatus';
import { EventTimeline } from '../../components/EventTimeline';
import { ForecastChart } from '../../components/ForecastChart';
import { BarRow } from '../../components/charts';
import {
  ErrorNote,
  Loading,
  Meter,
  Metric,
  MetricGrid,
  Panel,
  STATE_CLASS,
  STATE_LABEL,
} from '../../components/ui';
import type { FlowState } from '../../types';

/**
 * City Command.
 *
 * Network-wide supply, demand, node states, events and risk. The layout puts
 * the network schematic at the centre because every question on this screen is
 * ultimately spatial — which part of the city, and is it spreading.
 */

const STATES: FlowState[] = ['STABLE', 'DRIFT', 'PRE_DISTURBANCE', 'DISTURBANCE'];

export function CityCommand() {
  const navigate = useNavigate();

  const overview = useQuery((c) => c.getCityOverview(), []);
  const nodes = useQuery((c) => c.getNodes(), []);
  const network = useQuery((c) => c.getNetwork(), []);
  const zones = useQuery((c) => c.getZones(), []);
  const events = useQuery((c) => c.getEvents({ limit: 40 }), []);
  const forecast = useQuery((c) => c.getForecasts({ scope: 'CITY' }), []);

  const attention = useMemo(
    () =>
      (nodes.data ?? [])
        .filter((n) => n.state !== 'STABLE' || n.health !== 'OK')
        .sort((a, b) => b.anomaly_score - a.anomaly_score),
    [nodes.data],
  );

  if (overview.error) return <ErrorNote error={overview.error} />;
  if (!overview.data || !nodes.data || !network.data) return <Loading what="the network" />;

  const o = overview.data;
  const balance = o.supply_lps - o.demand_lps;

  return (
    <div className="page city-command">
      <div className="cc-strip">
        <Panel className="kpi">
          <MetricGrid columns={4}>
            <Metric
              label="Supply"
              value={o.supply_lps.toFixed(0)}
              unit="L/s"
              hint="Sum of measured outlet flow across all AquaNereon junctions."
            />
            <Metric
              label="Demand"
              value={o.demand_lps.toFixed(0)}
              unit="L/s"
              hint="Modelled zone demand at the current hour."
            />
            <Metric
              label="Balance"
              value={`${balance >= 0 ? '+' : ''}${balance.toFixed(0)}`}
              unit="L/s"
              tone={balance < 0 ? 'hot' : balance < 10 ? 'warn' : 'ok'}
              hint="Supply minus modelled demand. Negative means the network is drawing down storage."
            />
            <Metric
              label="Reservoir"
              value={Math.round(o.reservoir_fraction * 100)}
              unit="%"
              tone={o.reservoir_fraction < 0.35 ? 'warn' : undefined}
            />
          </MetricGrid>
        </Panel>

        <Panel className="kpi">
          <div className="state-roll">
            {STATES.map((state) => (
              <div key={state} className={`sr-cell ${STATE_CLASS[state]}`}>
                <b>{o.nodes_by_state[state]}</b>
                <span>{STATE_LABEL[state]}</span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel className="kpi">
          <MetricGrid columns={2}>
            <Metric
              label="Open events"
              value={o.open_events}
              tone={o.open_events > 0 ? 'warn' : 'ok'}
            />
            <Metric
              label="Highest severity"
              value={o.highest_severity ?? '—'}
              tone={
                o.highest_severity === 'HIGH' || o.highest_severity === 'CRITICAL'
                  ? 'hot'
                  : o.highest_severity
                    ? 'warn'
                    : 'ok'
              }
            />
          </MetricGrid>
          <div className="kpi-loss">
            <span>Estimated losses</span>
            <Meter
              value={o.estimated_loss_fraction}
              tone={o.estimated_loss_fraction > 0.25 ? 'hot' : 'warn'}
            />
            <b>{Math.round(o.estimated_loss_fraction * 100)}%</b>
          </div>
        </Panel>
      </div>

      <div className="cc-main">
        <Panel
          title="Network"
          subtitle="Hydraulic graph · upstream to downstream, left to right"
          className="cc-map"
        >
          <NetworkMap
            network={network.data}
            nodes={nodes.data}
            events={events.data?.items}
            onSelect={(id) => navigate(`/nodes/${id}`)}
            height={470}
          />
        </Panel>

        <div className="cc-side">
          <Panel
            title="Needs attention"
            subtitle={
              attention.length === 0
                ? 'All nodes within baseline'
                : `${attention.length} of ${o.nodes_total} nodes`
            }
            scroll
            className="cc-attention"
          >
            {attention.length === 0 ? (
              <div className="empty">Every node is reading within its baseline.</div>
            ) : (
              attention.map((node) => (
                <NodeStatus key={node.node_id} node={node} asLink />
              ))
            )}
          </Panel>

          <Panel title="Events" subtitle="Prioritised by severity" scroll className="cc-events">
            <EventTimeline
              events={events.data?.items ?? []}
              limit={8}
              onSelect={(id) => navigate(`/events?event=${id}`)}
            />
          </Panel>
        </div>
      </div>

      <div className="cc-bottom">
        <Panel
          title="City demand forecast"
          subtitle="24-hour horizon with prediction interval"
          className="cc-forecast"
        >
          {forecast.data?.[0] ? (
            <ForecastChart forecast={forecast.data[0]} supplyLps={o.supply_lps} height={200} />
          ) : (
            <Loading what="forecast" />
          )}
        </Panel>

        <Panel title="Zones" subtitle="Supply against modelled demand" className="cc-zones">
          {(zones.data ?? []).map((zone) => {
            const max = Math.max(zone.supply_lps, zone.demand_lps) * 1.15;
            return (
              <div key={zone.zone_id} className="zone-row">
                <div className="zone-head">
                  <strong>{zone.name}</strong>
                  <span className={STATE_CLASS[zone.worst_state]}>
                    {STATE_LABEL[zone.worst_state]}
                  </span>
                </div>
                <BarRow
                  label="supply"
                  value={zone.supply_lps}
                  max={max}
                  color="var(--a)"
                  caption={`${zone.supply_lps.toFixed(0)} L/s`}
                />
                <BarRow
                  label="demand"
                  value={zone.demand_lps}
                  max={max}
                  color="var(--b)"
                  caption={`${zone.demand_lps.toFixed(0)} L/s`}
                />
                <div className="zone-foot">
                  <span>losses {Math.round(zone.loss_fraction * 100)}%</span>
                  <span>{zone.open_events} open</span>
                  <a href={`/zones/${zone.zone_id}`} onClick={(e) => {
                    e.preventDefault();
                    navigate(`/zones/${zone.zone_id}`);
                  }}>
                    open zone →
                  </a>
                </div>
              </div>
            );
          })}
        </Panel>
      </div>
    </div>
  );
}
