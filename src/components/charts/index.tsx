import { useMemo, useState, type ReactNode } from 'react';

/**
 * Chart primitives, hand-drawn in SVG.
 *
 * The dossier proposes Plotly or ECharts. Both are excellent and both are
 * around half a megabyte, and neither would match the instrument styling
 * without a page of theme overrides. What the screens actually need is four
 * shapes — a line, a band, a bar row and a sparkline — so they are drawn
 * directly. That keeps the bundle honest, gives full control over how a
 * threshold or a prediction interval reads, and means the charts inherit the
 * design tokens instead of fighting them.
 *
 * If the platform later needs brushing, zooming and export, that is the point
 * to bring a real charting library in behind this same component surface.
 */

export interface Series {
  id: string;
  label: string;
  color: string;
  points: { x: number; y: number }[];
  /** Draw as a dashed line, for a reference or a baseline. */
  dashed?: boolean;
  width?: number;
  /** Fill under the line, 0..1 opacity. */
  fill?: number;
}

export interface Band {
  id: string;
  color: string;
  opacity?: number;
  points: { x: number; lo: number; hi: number }[];
}

export interface Marker {
  x: number;
  label?: string;
  color?: string;
}

export interface Threshold {
  y: number;
  label?: string;
  color?: string;
}

interface Scale {
  x: (v: number) => number;
  y: (v: number) => number;
  invX: (px: number) => number;
}

const PAD = { top: 10, right: 10, bottom: 20, left: 40 };

function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [min];
  const span = max - min;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const first = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = first; v <= max + step * 0.001; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

export interface TimeSeriesChartProps {
  series: Series[];
  bands?: Band[];
  markers?: Marker[];
  thresholds?: Threshold[];
  height?: number;
  /** Force the y range; otherwise it is taken from the data. */
  yDomain?: [number, number];
  yFormat?: (v: number) => string;
  xFormat?: (v: number) => string;
  /** Shown under the chart. */
  legend?: boolean;
  unit?: string;
  ariaLabel?: string;
}

export function TimeSeriesChart({
  series,
  bands = [],
  markers = [],
  thresholds = [],
  height = 160,
  yDomain,
  yFormat = (v) => v.toFixed(v >= 100 ? 0 : 1),
  xFormat,
  legend = true,
  unit,
  ariaLabel,
}: TimeSeriesChartProps) {
  // A fixed viewBox with preserveAspectRatio="none" lets the chart stretch to
  // its container without a resize observer; only the stroke width needs care.
  const W = 600;
  const H = height;
  const [hover, setHover] = useState<number | null>(null);

  const { scale, xs, ys, allX } = useMemo(() => {
    const points = series.flatMap((s) => s.points);
    const bandPts = bands.flatMap((b) => b.points);
    const xValues = [...points.map((p) => p.x), ...bandPts.map((p) => p.x)];
    const yValues = [
      ...points.map((p) => p.y),
      ...bandPts.flatMap((p) => [p.lo, p.hi]),
      ...thresholds.map((t) => t.y),
    ];

    const xMin = xValues.length ? Math.min(...xValues) : 0;
    const xMax = xValues.length ? Math.max(...xValues) : 1;
    let yMin = yDomain ? yDomain[0] : yValues.length ? Math.min(...yValues) : 0;
    let yMax = yDomain ? yDomain[1] : yValues.length ? Math.max(...yValues) : 1;
    if (yMin === yMax) {
      yMin -= 1;
      yMax += 1;
    }
    if (!yDomain) {
      const pad = (yMax - yMin) * 0.08;
      yMin -= pad;
      yMax += pad;
    }

    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    const sx = (v: number) =>
      PAD.left + (xMax === xMin ? plotW / 2 : ((v - xMin) / (xMax - xMin)) * plotW);
    const sy = (v: number) => PAD.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

    return {
      scale: {
        x: sx,
        y: sy,
        invX: (px: number) => xMin + ((px - PAD.left) / plotW) * (xMax - xMin),
      } satisfies Scale,
      xs: [xMin, xMax] as const,
      ys: niceTicks(yMin, yMax, 4),
      allX: xValues,
    };
  }, [series, bands, thresholds, yDomain, H]);

  const path = (pts: { x: number; y: number }[]) =>
    pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${scale.x(p.x).toFixed(2)},${scale.y(p.y).toFixed(2)}`).join(' ');

  const areaPath = (pts: { x: number; y: number }[]) => {
    if (pts.length === 0) return '';
    const base = H - PAD.bottom;
    return (
      `M${scale.x(pts[0].x).toFixed(2)},${base} ` +
      pts.map((p) => `L${scale.x(p.x).toFixed(2)},${scale.y(p.y).toFixed(2)}`).join(' ') +
      ` L${scale.x(pts[pts.length - 1].x).toFixed(2)},${base} Z`
    );
  };

  const bandPath = (b: Band) => {
    if (b.points.length === 0) return '';
    const up = b.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${scale.x(p.x).toFixed(2)},${scale.y(p.hi).toFixed(2)}`);
    const down = [...b.points]
      .reverse()
      .map((p) => `L${scale.x(p.x).toFixed(2)},${scale.y(p.lo).toFixed(2)}`);
    return `${up.join(' ')} ${down.join(' ')} Z`;
  };

  const hoverX = hover !== null ? scale.invX(hover) : null;
  const nearest =
    hoverX === null || allX.length === 0
      ? null
      : allX.reduce((best, v) => (Math.abs(v - hoverX) < Math.abs(best - hoverX) ? v : best), allX[0]);

  return (
    <div className="chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={ariaLabel}
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setHover(((e.clientX - rect.left) / rect.width) * W);
        }}
        onPointerLeave={() => setHover(null)}
      >
        {/* horizontal guides */}
        {ys.map((v) => (
          <g key={v}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={scale.y(v)}
              y2={scale.y(v)}
              className="chart-grid"
            />
            <text x={PAD.left - 6} y={scale.y(v) + 3} className="chart-axis" textAnchor="end">
              {yFormat(v)}
            </text>
          </g>
        ))}

        {bands.map((b) => (
          <path key={b.id} d={bandPath(b)} fill={b.color} opacity={b.opacity ?? 0.16} />
        ))}

        {thresholds.map((t, i) => (
          <g key={i}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={scale.y(t.y)}
              y2={scale.y(t.y)}
              stroke={t.color ?? 'var(--ink-faint)'}
              strokeDasharray="4 4"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            {t.label && (
              <text
                x={W - PAD.right - 4}
                y={scale.y(t.y) - 4}
                className="chart-axis"
                textAnchor="end"
                fill={t.color ?? 'var(--ink-faint)'}
              >
                {t.label}
              </text>
            )}
          </g>
        ))}

        {series.map((s) =>
          s.fill ? (
            <path key={`${s.id}-fill`} d={areaPath(s.points)} fill={s.color} opacity={s.fill} />
          ) : null,
        )}

        {series.map((s) => (
          <path
            key={s.id}
            d={path(s.points)}
            fill="none"
            stroke={s.color}
            strokeWidth={s.width ?? 1.6}
            strokeDasharray={s.dashed ? '5 4' : undefined}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {markers.map((m, i) => (
          <line
            key={i}
            x1={scale.x(m.x)}
            x2={scale.x(m.x)}
            y1={PAD.top}
            y2={H - PAD.bottom}
            stroke={m.color ?? 'var(--state-disturbance)'}
            strokeWidth={1}
            opacity={0.7}
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {nearest !== null && (
          <line
            x1={scale.x(nearest)}
            x2={scale.x(nearest)}
            y1={PAD.top}
            y2={H - PAD.bottom}
            className="chart-cursor"
            vectorEffect="non-scaling-stroke"
          />
        )}

        {xFormat && (
          <>
            <text x={PAD.left} y={H - 6} className="chart-axis" textAnchor="start">
              {xFormat(xs[0])}
            </text>
            <text x={W - PAD.right} y={H - 6} className="chart-axis" textAnchor="end">
              {xFormat(xs[1])}
            </text>
          </>
        )}
      </svg>

      {legend && (
        <div className="chart-legend">
          {series.map((s) => (
            <span key={s.id}>
              <i style={{ background: s.color }} />
              {s.label}
              {nearest !== null &&
                (() => {
                  const p = s.points.reduce<{ x: number; y: number } | null>(
                    (best, q) =>
                      best === null || Math.abs(q.x - nearest) < Math.abs(best.x - nearest)
                        ? q
                        : best,
                    null,
                  );
                  return p ? <b>{yFormat(p.y)}{unit}</b> : null;
                })()}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sparkline                                                           */
/* ------------------------------------------------------------------ */

export function Sparkline({
  values,
  color = 'var(--a)',
  height = 28,
  fill = true,
}: {
  values: number[];
  color?: string;
  height?: number;
  fill?: boolean;
}) {
  if (values.length < 2) return <div className="sparkline" style={{ height }} />;
  const W = 100;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => ({
    x: (i / (values.length - 1)) * W,
    y: height - ((v - min) / span) * (height - 3) - 1.5,
  }));
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');

  return (
    <svg className="sparkline" viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" style={{ height }}>
      {fill && <path d={`${d} L${W},${height} L0,${height} Z`} fill={color} opacity={0.14} />}
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={1.4}
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Horizontal bars                                                     */
/* ------------------------------------------------------------------ */

export function BarRow({
  label,
  value,
  max,
  color = 'var(--a)',
  caption,
}: {
  label: ReactNode;
  value: number;
  max: number;
  color?: string;
  caption?: ReactNode;
}) {
  const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) * 100 : 0;
  return (
    <div className="bar-row">
      <span className="bar-label">{label}</span>
      <span className="bar-track">
        <span className="bar-fill" style={{ width: `${pct}%`, background: color }} />
      </span>
      <span className="bar-caption">{caption}</span>
    </div>
  );
}
