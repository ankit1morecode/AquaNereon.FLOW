import { useMemo } from 'react';
import type { FlowSignature } from '../../types';
import { TimeSeriesChart, type Series } from '../charts';
import { clockTime } from '../ui';

/**
 * The flow signature over time.
 *
 * Shows the quantity the four-state machine actually classifies on — the
 * baseline distance — against the thresholds it is compared to, so the badge
 * on the page is checkable rather than declarative. The secondary traces are
 * the two features that carry most of that distance, plotted on the same axis
 * as fractions so their shapes can be compared to the deviation they explain.
 */

const THRESHOLDS = { drift: 0.035, preDisturbance: 0.085, disturbance: 0.17 };

export interface FlowSignatureChartProps {
  signatures: FlowSignature[];
  height?: number;
  /** Also plot asymmetry and core deficit, not just the distance. */
  detailed?: boolean;
}

export function FlowSignatureChart({
  signatures,
  height = 190,
  detailed = true,
}: FlowSignatureChartProps) {
  const series = useMemo<Series[]>(() => {
    if (signatures.length === 0) return [];
    const t0 = new Date(signatures[0].timestamp).getTime();
    const x = (s: FlowSignature) => (new Date(s.timestamp).getTime() - t0) / 1000;

    const out: Series[] = [
      {
        id: 'distance',
        label: 'Baseline distance',
        color: 'var(--a)',
        width: 2,
        fill: 0.12,
        points: signatures.map((s) => ({ x: x(s), y: s.baseline_distance })),
      },
    ];

    if (detailed) {
      out.push(
        {
          id: 'asymmetry',
          label: 'Asymmetry',
          color: 'var(--state-drift)',
          width: 1.3,
          points: signatures.map((s) => ({ x: x(s), y: s.circumferential.asymmetry })),
        },
        {
          id: 'deficit',
          label: 'Core deficit ÷10',
          color: 'var(--state-pre)',
          width: 1.3,
          dashed: true,
          points: signatures.map((s) => ({ x: x(s), y: s.hydraulic.axial_deficit / 10 })),
        },
      );
    }

    return out;
  }, [signatures, detailed]);

  if (signatures.length < 2) {
    return <div className="empty">Collecting signature windows…</div>;
  }

  const first = new Date(signatures[0].timestamp).getTime();

  return (
    <TimeSeriesChart
      series={series}
      height={height}
      yFormat={(v) => v.toFixed(2)}
      xFormat={(v) => clockTime(new Date(first + v * 1000).toISOString())}
      ariaLabel="Flow signature deviation from baseline over time"
      thresholds={[
        { y: THRESHOLDS.drift, label: 'drift', color: 'var(--state-drift)' },
        { y: THRESHOLDS.preDisturbance, label: 'pre-dist.', color: 'var(--state-pre)' },
        { y: THRESHOLDS.disturbance, label: 'disturbance', color: 'var(--state-disturbance)' },
      ]}
    />
  );
}
