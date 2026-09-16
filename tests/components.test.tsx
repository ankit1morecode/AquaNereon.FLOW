/**
 * @vitest-environment jsdom
 *
 * Component tests.
 *
 * Deliberately a small, targeted set rather than broad snapshot coverage. Each
 * one exists because of a specific way this interface can mislead or break:
 * a panel that resizes when a state changes, a chart that throws on a
 * degenerate series, a canvas that is not implemented in the test environment,
 * a boundary that does not catch. Snapshots would pass through all of those.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';

import {
  ALL_STATES,
  Metric,
  Meter,
  StateBadge,
  clockTime,
  relativeTime,
} from '../src/components/ui';
import { TimeSeriesChart, Sparkline, BarRow } from '../src/components/charts';
import { EventTimeline } from '../src/components/EventTimeline';
import { EvidencePanel } from '../src/components/EvidencePanel';
import { CircumferentialProfile } from '../src/components/CircumferentialProfile';
import { NodeStatus } from '../src/components/NodeStatus';
import { PageErrorBoundary } from '../src/app/PageErrorBoundary';
import type { CircumferentialFeatures, NodeSummary, WaterEvent } from '../src/types';

afterEach(cleanup);

const withRouter = (ui: ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function event(over: Partial<WaterEvent> = {}): WaterEvent {
  return {
    event_id: 'EV-1',
    event_type: 'FLOW_ANOMALY',
    node_id: 'AN-J-014',
    zone_id: 'Z-CENTRAL',
    timestamp: new Date(Date.now() - 30_000).toISOString(),
    severity: 'HIGH',
    anomaly_score: 0.72,
    state_transition: { from: 'DRIFT', to: 'DISTURBANCE' },
    evidence: [
      { kind: 'SIGNATURE_DEVIATION', label: 'Baseline distance', value: '0.210', weight: 0.84 },
      { kind: 'PERSISTENCE', label: 'Persistence', value: '100%', weight: 1 },
    ],
    model_outputs: [
      {
        model_id: 'AI-01',
        model_version: '0.3.1',
        prediction: 'DISTURBANCE',
        score: 0.72,
        confidence: 0.88,
        contributing_features: ['circumferential.asymmetry'],
        explanation: ['Distribution departed from baseline.'],
      },
    ],
    network_context: { upstream_states: [], downstream_states: [], propagation: 'LOCAL' },
    data_quality: { completeness: 1, confidence: 0.9, stale: false, suspect_channels: [] },
    status: 'OPEN',
    ...over,
  };
}

function nodeSummary(over: Partial<NodeSummary> = {}): NodeSummary {
  return {
    node_id: 'AN-J-014',
    zone_id: 'Z-CENTRAL',
    hardware_version: 'AN-HW-2.1',
    firmware_version: '0.9.4',
    location: { lat: 54.97, lng: -1.61, label: 'Exchange junction' },
    nominal_flow_lps: 36,
    upstream: [],
    downstream: [],
    commissioned_at: '',
    state: 'STABLE',
    health: 'OK',
    anomaly_score: 0.05,
    flow_lps: 24,
    sampling_mode: 'NORMAL',
    last_seen: new Date().toISOString(),
    ...over,
  };
}

const features: CircumferentialFeatures = {
  channel_features: new Array(16).fill(1),
  distribution_vector: new Array(16).fill(1),
  asymmetry: 0.09,
  sector_imbalance: 0.6,
  spatial_gradient: 0.04,
  modes: [0.18, 0.11, 0.05],
  mode1_phase: 1.2,
};

/* ------------------------------------------------------------------ */
/* State badge — the widest-reaching layout-stability guarantee         */
/* ------------------------------------------------------------------ */

describe('StateBadge', () => {
  it('renders every label so its width cannot depend on the state', () => {
    // The badge sits in headers and list rows everywhere. If it resized with
    // the state it reports, every escalation would nudge the layout.
    const { container } = render(<StateBadge state="STABLE" />);
    const labels = container.querySelectorAll('.sb-labels > span');
    expect(labels).toHaveLength(ALL_STATES.length);
  });

  it('exposes only the active label to assistive technology', () => {
    const { container } = render(<StateBadge state="PRE_DISTURBANCE" />);
    const visible = container.querySelectorAll('.sb-labels > span:not([aria-hidden="true"])');
    expect(visible).toHaveLength(1);
    expect(visible[0].textContent).toBe('Pre-disturbance');
  });

  it('marks the active label and only that one', () => {
    for (const state of ALL_STATES) {
      cleanup();
      const { container } = render(<StateBadge state={state} />);
      expect(container.querySelectorAll('.sb-labels > span.on')).toHaveLength(1);
    }
  });
});

describe('Metric', () => {
  it('always renders the trend slot, so a value does not shift when one appears', () => {
    const without = render(<Metric label="A" value="1" />);
    expect(without.container.querySelectorAll('.trend')).toHaveLength(1);
    expect(without.container.querySelector('.trend')?.className).toContain('flat');
    cleanup();

    const withTrend = render(<Metric label="A" value="1" trend={0.5} />);
    expect(withTrend.container.querySelectorAll('.trend')).toHaveLength(1);
    expect(withTrend.container.querySelector('.trend')?.className).toContain('up');
  });
});

describe('Meter', () => {
  it('clamps out-of-range values instead of overflowing its track', () => {
    const { container } = render(<Meter value={4} />);
    expect((container.querySelector('.meter-fill') as HTMLElement).style.width).toBe('100%');
    cleanup();
    const neg = render(<Meter value={-2} />);
    expect((neg.container.querySelector('.meter-fill') as HTMLElement).style.width).toBe('0%');
  });
});

describe('relative time', () => {
  it('never reads as a time in the future', () => {
    // The simulator's clock can run marginally ahead; "in 5s ago" is nonsense.
    expect(relativeTime(new Date(Date.now() + 5000).toISOString())).toBe('just now');
  });

  it('degrades gracefully on an unparseable timestamp', () => {
    expect(relativeTime('not a date')).toBe('—');
  });

  it('scales from seconds to days', () => {
    const now = Date.now();
    expect(relativeTime(new Date(now - 10_000).toISOString(), now)).toMatch(/s ago/);
    expect(relativeTime(new Date(now - 600_000).toISOString(), now)).toMatch(/m ago/);
    expect(relativeTime(new Date(now - 7_200_000).toISOString(), now)).toMatch(/h ago/);
    expect(relativeTime(new Date(now - 200_000_000).toISOString(), now)).toMatch(/d ago/);
  });

  it('pads the clock to a fixed width', () => {
    expect(clockTime(new Date(2026, 0, 1, 4, 5).toISOString())).toBe('04:05');
  });
});

/* ------------------------------------------------------------------ */
/* Charts — degenerate data is where chart code throws                 */
/* ------------------------------------------------------------------ */

describe('TimeSeriesChart', () => {
  const series = (points: { x: number; y: number }[]) => [
    { id: 's', label: 'S', color: '#fff', points },
  ];

  it('renders a normal series', () => {
    const { container } = render(
      <TimeSeriesChart series={series([{ x: 0, y: 1 }, { x: 1, y: 3 }])} />,
    );
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('survives an empty series', () => {
    expect(() => render(<TimeSeriesChart series={[]} />)).not.toThrow();
  });

  it('survives a single point, where the domain has zero width', () => {
    expect(() => render(<TimeSeriesChart series={series([{ x: 5, y: 5 }])} />)).not.toThrow();
  });

  it('survives a flat series, where the y range would collapse', () => {
    const { container } = render(
      <TimeSeriesChart series={series([{ x: 0, y: 2 }, { x: 1, y: 2 }, { x: 2, y: 2 }])} />,
    );
    // A zero-height range must not produce NaN in the path data.
    const d = container.querySelector('path[stroke]')?.getAttribute('d') ?? '';
    expect(d).not.toContain('NaN');
  });

  it('keeps band and threshold geometry free of NaN', () => {
    const { container } = render(
      <TimeSeriesChart
        series={series([{ x: 0, y: 1 }, { x: 1, y: 2 }])}
        bands={[{ id: 'b', color: '#fff', points: [{ x: 0, lo: 0, hi: 2 }, { x: 1, lo: 1, hi: 3 }] }]}
        thresholds={[{ y: 1.5, label: 'edge' }]}
      />,
    );
    for (const path of container.querySelectorAll('path')) {
      expect(path.getAttribute('d') ?? '').not.toContain('NaN');
    }
  });
});

describe('Sparkline and BarRow', () => {
  it('renders nothing breakable for a series too short to draw', () => {
    expect(() => render(<Sparkline values={[]} />)).not.toThrow();
    expect(() => render(<Sparkline values={[1]} />)).not.toThrow();
  });

  it('does not divide by a zero maximum', () => {
    const { container } = render(<BarRow label="x" value={5} max={0} />);
    expect((container.querySelector('.bar-fill') as HTMLElement).style.width).toBe('0%');
  });
});

/* ------------------------------------------------------------------ */
/* Canvas components — jsdom provides no 2D context                    */
/* ------------------------------------------------------------------ */

describe('CircumferentialProfile', () => {
  it('renders without a canvas context rather than throwing', () => {
    // jsdom returns null from getContext. Anything that assumes a context is
    // available will fail here, which is the same failure a browser with
    // canvas disabled would produce.
    expect(() => render(<CircumferentialProfile features={features} />)).not.toThrow();
  });

  it('shows the feature values as text, not only as a drawing', () => {
    render(<CircumferentialProfile features={features} />);
    expect(screen.getByText('0.090')).toBeTruthy(); // asymmetry
    expect(screen.getByText('0.60')).toBeTruthy(); // sector imbalance
    expect(screen.getByText('0.180')).toBeTruthy(); // mode 1
  });
});

/* ------------------------------------------------------------------ */
/* Event list and evidence                                             */
/* ------------------------------------------------------------------ */

describe('EventTimeline', () => {
  it('puts open events above closed ones regardless of age', () => {
    const { container } = render(
      <EventTimeline
        events={[
          event({ event_id: 'old-open', status: 'OPEN', severity: 'LOW', timestamp: new Date(Date.now() - 900_000).toISOString() }),
          event({ event_id: 'new-closed', status: 'CLOSED', severity: 'CRITICAL', timestamp: new Date().toISOString() }),
        ]}
      />,
    );
    const rows = container.querySelectorAll('.event-row');
    expect(within(rows[0] as HTMLElement).getByText(/open/i)).toBeTruthy();
  });

  it('orders open events by severity, not recency', () => {
    const { container } = render(
      <EventTimeline
        events={[
          event({ event_id: 'low', severity: 'LOW', timestamp: new Date().toISOString() }),
          event({ event_id: 'critical', severity: 'CRITICAL', timestamp: new Date(Date.now() - 60_000).toISOString() }),
        ]}
      />,
    );
    const first = container.querySelector('.event-row') as HTMLElement;
    expect(within(first).getByText('CRITICAL')).toBeTruthy();
  });

  it('reverses to chronological when asked', () => {
    const { container } = render(
      <EventTimeline
        chronological
        events={[
          event({ event_id: 'older', severity: 'CRITICAL', timestamp: new Date(Date.now() - 60_000).toISOString() }),
          event({ event_id: 'newer', severity: 'LOW', timestamp: new Date().toISOString() }),
        ]}
      />,
    );
    const first = container.querySelector('.event-row') as HTMLElement;
    expect(within(first).getByText('LOW')).toBeTruthy();
  });

  it('shows the state transition, not just the destination', () => {
    render(<EventTimeline events={[event()]} />);
    expect(screen.getByText('Drift')).toBeTruthy();
    expect(screen.getByText('Disturbance')).toBeTruthy();
  });

  it('explains an empty list instead of showing a blank panel', () => {
    render(<EventTimeline events={[]} emptyNote="Nothing here." />);
    expect(screen.getByText('Nothing here.')).toBeTruthy();
  });

  it('calls back with the event id when a row is clicked', () => {
    const onSelect = vi.fn();
    const { container } = render(<EventTimeline events={[event()]} onSelect={onSelect} />);
    (container.querySelector('.event-row') as HTMLElement).click();
    expect(onSelect).toHaveBeenCalledWith('EV-1');
  });
});

describe('EvidencePanel', () => {
  it('shows every evidence item, because a hidden one is a hidden reason', () => {
    withRouter(<EvidencePanel event={event()} />);
    expect(screen.getByText('Baseline distance')).toBeTruthy();
    expect(screen.getByText('Persistence')).toBeTruthy();
  });

  it('shows the model explanation rather than only its verdict', () => {
    withRouter(<EvidencePanel event={event()} />);
    expect(screen.getByText('Distribution departed from baseline.')).toBeTruthy();
    expect(screen.getByText('circumferential.asymmetry')).toBeTruthy();
  });

  it('says plainly when there are no neighbours, instead of leaving a gap', () => {
    withRouter(<EvidencePanel event={event()} />);
    expect(screen.getAllByText('none').length).toBeGreaterThanOrEqual(2);
  });

  it('surfaces a suspected origin with its confidence', () => {
    withRouter(
      <EvidencePanel
        event={event({ suspected_origin: { description: 'Between A and B', confidence: 0.54 } })}
      />,
    );
    expect(screen.getByText(/Between A and B/)).toBeTruthy();
    expect(screen.getByText(/confidence 0\.54/)).toBeTruthy();
  });

  it('disables the status the event is already in', () => {
    withRouter(<EvidencePanel event={event({ status: 'CLOSED' })} onStatusChange={vi.fn()} />);
    expect((screen.getByRole('button', { name: 'closed' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe('NodeStatus', () => {
  it('marks a node the software has escalated on its own', () => {
    withRouter(
      <NodeStatus node={nodeSummary({ sampling_mode: 'HIGH_RESOLUTION' })} asLink />,
    );
    const el = screen.getByText(/high-resolution/);
    expect(el.className).toContain('active');
  });

  it('flags a node running above its nominal duty', () => {
    const { container } = withRouter(
      <NodeStatus node={nodeSummary({ flow_lps: 50, nominal_flow_lps: 36 })} asLink />,
    );
    expect(container.querySelector('.ns-figures .warn')).toBeTruthy();
  });

  it('links to the node it describes', () => {
    withRouter(<NodeStatus node={nodeSummary()} asLink />);
    expect(screen.getByRole('link').getAttribute('href')).toBe('/nodes/AN-J-014');
  });
});

/* ------------------------------------------------------------------ */
/* Error boundary                                                      */
/* ------------------------------------------------------------------ */

describe('PageErrorBoundary', () => {
  function Boom(): ReactElement {
    throw new Error('bad value from the API');
  }

  it('contains a throwing page instead of blanking the application', () => {
    // React logs the caught error; silence it so the run stays readable.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <PageErrorBoundary>
        <Boom />
      </PageErrorBoundary>,
    );
    expect(screen.getByText(/could not be rendered/i)).toBeTruthy();
    // The message matters: "something went wrong" tells an operator nothing.
    expect(screen.getByText('bad value from the API')).toBeTruthy();
    spy.mockRestore();
  });

  it('offers a way out', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <PageErrorBoundary>
        <Boom />
      </PageErrorBoundary>,
    );
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /city command/i })).toBeTruthy();
    spy.mockRestore();
  });

  it('renders its children untouched when nothing throws', () => {
    render(
      <PageErrorBoundary>
        <p>all good</p>
      </PageErrorBoundary>,
    );
    expect(screen.getByText('all good')).toBeTruthy();
  });
});
