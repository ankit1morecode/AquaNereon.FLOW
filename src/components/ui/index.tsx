import type { ReactNode } from 'react';
import type { FlowState, HealthStatus, Severity } from '../../types';

/**
 * Shared presentation primitives.
 *
 * Small on purpose. Everything here exists because at least three screens
 * needed the same thing and having three slightly different versions of a
 * state badge would mean the colour stopped being a reliable signal.
 */

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className = '',
  scroll = false,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  scroll?: boolean;
}) {
  return (
    <section className={`panel ${className}`}>
      {(title || actions) && (
        <header className="panel-head">
          <div>
            {title && <h2>{title}</h2>}
            {subtitle && <p>{subtitle}</p>}
          </div>
          {actions && <div className="panel-actions">{actions}</div>}
        </header>
      )}
      <div className={scroll ? 'panel-body panel-body-scroll' : 'panel-body'}>{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* State and severity                                                  */
/* ------------------------------------------------------------------ */

export const STATE_LABEL: Record<FlowState, string> = {
  STABLE: 'Stable',
  DRIFT: 'Drift',
  PRE_DISTURBANCE: 'Pre-disturbance',
  DISTURBANCE: 'Disturbance',
};

export const STATE_CLASS: Record<FlowState, string> = {
  STABLE: 'st-stable',
  DRIFT: 'st-drift',
  PRE_DISTURBANCE: 'st-pre',
  DISTURBANCE: 'st-disturbance',
};

export function StateBadge({
  state,
  size = 'md',
  pulse,
}: {
  state: FlowState;
  size?: 'sm' | 'md';
  pulse?: boolean;
}) {
  const shouldPulse = pulse ?? state === 'DISTURBANCE';
  return (
    <span
      className={`state-badge ${STATE_CLASS[state]} ${size === 'sm' ? 'sb-sm' : ''} ${
        shouldPulse ? 'sb-pulse' : ''
      }`}
    >
      <i />
      {STATE_LABEL[state]}
    </span>
  );
}

export const SEVERITY_CLASS: Record<Severity, string> = {
  INFO: 'sev-info',
  LOW: 'sev-low',
  MEDIUM: 'sev-medium',
  HIGH: 'sev-high',
  CRITICAL: 'sev-critical',
};

export function SeverityTag({ severity }: { severity: Severity }) {
  return <span className={`sev-tag ${SEVERITY_CLASS[severity]}`}>{severity}</span>;
}

export function HealthDot({ health }: { health: HealthStatus }) {
  const cls =
    health === 'OK'
      ? 'hd-ok'
      : health === 'DEGRADED'
        ? 'hd-degraded'
        : health === 'FAULT'
          ? 'hd-fault'
          : 'hd-offline';
  return <span className={`health-dot ${cls}`} title={`Health: ${health}`} />;
}

/* ------------------------------------------------------------------ */
/* Numbers                                                             */
/* ------------------------------------------------------------------ */

export function Metric({
  label,
  value,
  unit,
  hint,
  tone,
  trend,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  hint?: string;
  tone?: 'ok' | 'warn' | 'hot';
  trend?: number;
}) {
  return (
    <div className="metric" title={hint}>
      <span className="metric-label">{label}</span>
      <span className={`metric-value ${tone ? `mv-${tone}` : ''}`}>
        {value}
        {unit && <em>{unit}</em>}
        {trend !== undefined && Math.abs(trend) > 1e-6 && (
          <i className={trend > 0 ? 'trend up' : 'trend down'}>{trend > 0 ? '▲' : '▼'}</i>
        )}
      </span>
    </div>
  );
}

export function MetricGrid({ children, columns = 2 }: { children: ReactNode; columns?: number }) {
  return (
    <div className="metric-grid" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
      {children}
    </div>
  );
}

/** Horizontal proportion bar, used for losses, risk and evidence weight. */
export function Meter({
  value,
  tone = 'a',
  label,
}: {
  /** 0..1 */
  value: number;
  tone?: 'a' | 'ok' | 'warn' | 'hot';
  label?: string;
}) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="meter" title={label}>
      <span className={`meter-fill mf-${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Loading({ what = 'data' }: { what?: string }) {
  return (
    <div className="empty">
      <span className="spinner" /> Loading {what}…
    </div>
  );
}

export function ErrorNote({ error }: { error: Error }) {
  return (
    <div className="error-note">
      <strong>Could not load.</strong> {error.message}
    </div>
  );
}

/** Relative time, in the terse form an operator reads at a glance. */
export function relativeTime(iso: string, now = Date.now()): string {
  const delta = (now - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(delta)) return '—';
  // A stamp a moment in the future is clock skew, not a prediction.
  if (delta < 1) return 'just now';
  if (delta < 45) return `${Math.round(delta)}s ago`;
  if (delta < 3600) return `${Math.round(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.round(delta / 3600)}h ago`;
  return `${Math.round(delta / 86400)}d ago`;
}

export function clockTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
