import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '../../services/ApiProvider';
import { NetworkMap } from '../../components/NetworkMap';
import { NodeStatus } from '../../components/NodeStatus';
import { EventTimeline } from '../../components/EventTimeline';
import { ForecastChart } from '../../components/ForecastChart';
import { TimeSeriesChart } from '../../components/charts';
import {
  ErrorNote,
  Loading,
  Meter,
  Metric,
  MetricGrid,
  Panel,
  STATE_CLASS,
  STATE_LABEL,
  clockTime,
} from '../../components/ui';

/**
 * Zone Intelligence.
 *
 * Consumption, forecast demand, losses, anomalies and shortage risk for one
 * zone. The loss figure is the one that needs care: it is inferred from the
 * circumferential asymmetry the rings in this zone are reporting, not measured,
 * and the page says so rather than presenting it as a meter reading.
 */
export function ZoneIntelligence() {
  const { zoneId } = useParams<{ zoneId: string }>();
  const navigate = useNavigate();

  const zones = useQuery((c) => c.getZones(), []);
  const nodes = useQuery((c) => c.getNodes(), []);
  const network = useQuery((c) => c.getNetwork(), []);
  const events = useQuery((c) => c.getEvents({ zone_id: zoneId, limit: 30 }), [zoneId]);
  const forecast = useQuery(
    (c) => c.getForecasts({ scope: 'ZONE', target_id: zoneId }),
    [zoneId],
  );

  if (zones.error) return <ErrorNote error={zones.error} />;
  if (!zones.data || !nodes.data || !network.data) return <Loading what="zone" />;

  const active = zones.data.find((z) => z.zone_id === zoneId) ?? zones.data[0];
  const zoneNodes = nodes.data.filter((n) => n.zone_id === active.zone_id);

  const consumption = active.consumption_series;
  const t0 = consumption.length ? new Date(consumption[0].t).getTime() : Date.now();

  return (
    <div className="page zone-intel">
      <div className="zone-tabs">
        {zones.data.map((z) => (
          <button
            key={z.zone_id}
            type="button"
            className={z.zone_id === active.zone_id ? 'tab active' : 'tab'}
            onClick={() => navigate(`/zones/${z.zone_id}`)}
          >
            {z.name}
            <span className={STATE_CLASS[z.worst_state]}>●</span>
          </button>
        ))}
      </div>

      <div className="zi-strip">
        <Panel className="kpi">
          <MetricGrid columns={4}>
            <Metric label="Population" value={(active.population / 1000).toFixed(0)} unit="k" />
            <Metric label="Supply" value={active.supply_lps.toFixed(0)} unit="L/s" />
            <Metric label="Demand" value={active.demand_lps.toFixed(0)} unit="L/s" />
            <Metric
              label="Forecast peak"
              value={active.forecast_peak_lps.toFixed(0)}
              unit="L/s"
              tone={active.forecast_peak_lps > active.supply_lps ? 'warn' : undefined}
              hint="Highest demand in the 24-hour profile for this zone."
            />
          </MetricGrid>
        </Panel>

        <Panel className="kpi">
          <div className="kpi-loss">
            <span>Inferred losses</span>
            <Meter
              value={active.loss_fraction}
              tone={active.loss_fraction > 0.25 ? 'hot' : 'warn'}
            />
            <b>{Math.round(active.loss_fraction * 100)}%</b>
          </div>
          <p className="kpi-note">
            Inferred from circumferential asymmetry across this zone's rings, not metered.
            Treat as an indication of where to look.
          </p>
        </Panel>

        <Panel className="kpi">
          <div className="kpi-loss">
            <span>Shortage risk</span>
            <Meter
              value={active.shortage_risk}
              tone={active.shortage_risk > 0.3 ? 'hot' : active.shortage_risk > 0.12 ? 'warn' : 'ok'}
            />
            <b>{Math.round(active.shortage_risk * 100)}%</b>
          </div>
          <p className="kpi-note">
            Forecast demand plus inferred losses against available supply at this hour.
          </p>
        </Panel>
      </div>

      <div className="zi-main">
        <Panel title="Consumption" subtitle="Last 24 hours, one point per hour">
          {consumption.length > 1 ? (
            <TimeSeriesChart
              height={180}
              unit=" L/s"
              series={[
                {
                  id: 'consumption',
                  label: 'Metered consumption',
                  color: 'var(--b)',
                  width: 1.8,
                  fill: 0.12,
                  points: consumption.map((p) => ({
                    x: (new Date(p.t).getTime() - t0) / 3600_000,
                    y: p.v,
                  })),
                },
              ]}
              yFormat={(v) => v.toFixed(0)}
              xFormat={(v) => clockTime(new Date(t0 + v * 3600_000).toISOString())}
              ariaLabel={`Consumption for ${active.name}`}
            />
          ) : (
            <Loading what="consumption" />
          )}
        </Panel>

        <Panel title="Demand forecast" subtitle="24-hour horizon">
          {forecast.data?.[0] ? (
            <ForecastChart
              forecast={forecast.data[0]}
              supplyLps={active.supply_lps}
              height={180}
            />
          ) : (
            <Loading what="forecast" />
          )}
        </Panel>
      </div>

      <div className="zi-lower">
        <Panel
          title="Zone network"
          subtitle={`${zoneNodes.length} junctions`}
          className="map-panel"
        >
          <NetworkMap
            network={network.data}
            nodes={nodes.data}
            events={events.data?.items}
            focusZone={active.zone_id}
            onSelect={(id) => navigate(`/nodes/${id}`)}
            height="100%"
          />
        </Panel>

        <div className="zi-side">
          <Panel title="Nodes" scroll className="zi-nodes">
            {zoneNodes.map((node) => (
              <NodeStatus key={node.node_id} node={node} asLink />
            ))}
          </Panel>

          <Panel
            title="Zone events"
            subtitle={`${active.open_events} open`}
            scroll
            className="zi-events"
          >
            <EventTimeline
              events={events.data?.items ?? []}
              limit={6}
              onSelect={(id) => navigate(`/events?event=${id}`)}
              emptyNote={`No events in ${active.name}.`}
            />
          </Panel>
        </div>
      </div>

      <footer className="zone-foot-note">
        Worst node state in this zone:{' '}
        <span className={STATE_CLASS[active.worst_state]}>{STATE_LABEL[active.worst_state]}</span>
      </footer>
    </div>
  );
}
