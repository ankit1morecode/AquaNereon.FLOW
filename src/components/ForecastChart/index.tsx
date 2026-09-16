import { useMemo } from 'react';
import type { DemandForecast } from '../../types';
import { TimeSeriesChart, type Band, type Series } from '../charts';
import { clockTime } from '../ui';

/**
 * Demand forecast with its prediction interval.
 *
 * The interval is drawn, not optional. A forecast line on its own invites an
 * operator to read it as a fact; the widening band is the honest statement of
 * how much less the model knows about hour 20 than about hour 2. The backtest
 * error sits next to it for the same reason — it is the one number that says
 * whether the line has earned any trust at all.
 */

export interface ForecastChartProps {
  forecast: DemandForecast;
  height?: number;
  /** Optional supply line, to show where forecast demand crosses it. */
  supplyLps?: number;
}

export function ForecastChart({ forecast, height = 210, supplyLps }: ForecastChartProps) {
  const { series, bands, t0, crossing } = useMemo(() => {
    const all = [...forecast.history, ...forecast.forecast];
    if (all.length === 0) {
      return { series: [] as Series[], bands: [] as Band[], t0: 0, crossing: null };
    }
    const base = new Date(all[0].t).getTime();
    const x = (iso: string) => (new Date(iso).getTime() - base) / 3600_000;

    const historySeries: Series = {
      id: 'history',
      label: 'Observed',
      color: 'var(--ink-dim)',
      width: 1.6,
      points: forecast.history.map((p) => ({ x: x(p.t), y: p.v })),
    };

    // Join the two lines at the issue point so there is no visual gap between
    // what happened and what is predicted.
    const joint = forecast.history[forecast.history.length - 1];
    const forecastSeries: Series = {
      id: 'forecast',
      label: 'Forecast',
      color: 'var(--a)',
      width: 2,
      points: [
        ...(joint ? [{ x: x(joint.t), y: joint.v }] : []),
        ...forecast.forecast.map((p) => ({ x: x(p.t), y: p.v })),
      ],
    };

    const band: Band = {
      id: 'interval',
      color: 'var(--a)',
      opacity: 0.14,
      points: forecast.forecast
        .filter((p) => p.lo !== undefined && p.hi !== undefined)
        .map((p) => ({ x: x(p.t), lo: p.lo as number, hi: p.hi as number })),
    };

    const out: Series[] = [historySeries, forecastSeries];

    // First hour where the upper interval crosses available supply: the point
    // the shortage model is actually reasoning about.
    let cross: number | null = null;
    if (supplyLps !== undefined) {
      out.push({
        id: 'supply',
        label: 'Supply',
        color: 'var(--state-stable)',
        width: 1.3,
        dashed: true,
        points: [
          { x: x(all[0].t), y: supplyLps },
          { x: x(all[all.length - 1].t), y: supplyLps },
        ],
      });
      const hit = forecast.forecast.find((p) => (p.hi ?? p.v) > supplyLps);
      if (hit) cross = x(hit.t);
    }

    return { series: out, bands: [band], t0: base, crossing: cross };
  }, [forecast, supplyLps]);

  if (series.length === 0) return <div className="empty">No forecast issued.</div>;

  return (
    <div className="forecast-chart">
      <TimeSeriesChart
        series={series}
        bands={bands}
        height={height}
        unit=" L/s"
        yFormat={(v) => v.toFixed(0)}
        xFormat={(v) => clockTime(new Date(t0 + v * 3600_000).toISOString())}
        markers={crossing !== null ? [{ x: crossing, label: 'supply crossed' }] : []}
        ariaLabel={`Demand forecast for ${forecast.target_id}`}
      />
      <div className="forecast-foot">
        <span>
          model <code>{forecast.model_id}</code> · {forecast.horizon_hours}h horizon
        </span>
        <span title="Mean absolute percentage error over the last completed horizon">
          backtest MAPE <b>{forecast.backtest_mape.toFixed(1)}%</b>
        </span>
        {crossing !== null && (
          <span className="forecast-warn">
            upper interval exceeds supply in {Math.round(crossing - (forecast.history.length - 1))}h
          </span>
        )}
      </div>
    </div>
  );
}
