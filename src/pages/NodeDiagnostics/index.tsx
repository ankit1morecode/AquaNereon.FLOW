import { useCallback, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useApi, useQuery } from '../../services/ApiProvider';
import { CircumferentialProfile } from '../../components/CircumferentialProfile';
import { FlowSignatureChart } from '../../components/FlowSignatureChart';
import { EventTimeline } from '../../components/EventTimeline';
import { AssessmentPanel } from '../../components/AssessmentPanel';
import { JunctionPreview } from '../../components/JunctionPreview';
import { TimeSeriesChart } from '../../components/charts';
import {
  ErrorNote,
  HealthDot,
  Loading,
  Metric,
  MetricGrid,
  Panel,
  StateBadge,
  STATE_CLASS,
  STATE_LABEL,
  clockTime,
  relativeTime,
} from '../../components/ui';
import type { CommandAck, SamplingMode } from '../../types';

/**
 * Node Diagnostics.
 *
 * The dossier is pointed about this screen: it must expose the physical-to-AI
 * chain rather than being "a generic dashboard full of decorative rectangles"
 * (§28). So it is laid out as that chain, top to bottom and left to right —
 * the water, then what the ring saw, then how far that is from baseline, then
 * what the state machine made of it, then what the operator can do about it.
 *
 * The 3D viewport and the circumferential plot next to it are two renderings
 * of the same computation, not an illustration beside a number.
 */

const SAMPLING_MODES: SamplingMode[] = [
  'NORMAL',
  'INCREASED',
  'HIGH_RESOLUTION',
  'VERIFICATION',
];

export function NodeDiagnostics() {
  const { nodeId = 'AN-J-014' } = useParams<{ nodeId: string }>();
  const navigate = useNavigate();
  const client = useApi();

  const nodes = useQuery((c) => c.getNodes(), []);
  const signature = useQuery((c) => c.getNodeSignature(nodeId), [nodeId]);
  const history = useQuery((c) => c.getNodeSignatureHistory(nodeId, 90), [nodeId]);
  const telemetry = useQuery((c) => c.getNodeTelemetry(nodeId, { limit: 120 }), [nodeId]);
  const health = useQuery((c) => c.getNodeHealth(nodeId), [nodeId]);
  const events = useQuery((c) => c.getEvents({ node_id: nodeId, limit: 12 }), [nodeId]);

  const [log, setLog] = useState<CommandAck[]>([]);
  const [pending, setPending] = useState<string | null>(null);

  const node = useMemo(
    () => nodes.data?.find((n) => n.node_id === nodeId),
    [nodes.data, nodeId],
  );

  // Neighbour states, so the live assessment can weigh whether anything
  // upstream explains what this node is seeing.
  const neighbours = useMemo(() => {
    const lookup = (ids: string[]) =>
      ids
        .map((id) => nodes.data?.find((n) => n.node_id === id))
        .filter((n): n is NonNullable<typeof n> => Boolean(n))
        .map((n) => ({ node_id: n.node_id, state: n.state }));
    return {
      upstream: lookup(node?.upstream ?? []),
      downstream: lookup(node?.downstream ?? []),
    };
  }, [node, nodes.data]);

  const issue = useCallback(
    async (label: string, run: () => Promise<CommandAck>) => {
      setPending(label);
      try {
        const ack = await run();
        setLog((prev) => [ack, ...prev].slice(0, 6));
      } catch (err) {
        setLog((prev) =>
          [
            {
              command_id: '—',
              node_id: nodeId,
              accepted: false,
              issued_at: new Date().toISOString(),
              detail: err instanceof Error ? err.message : String(err),
            },
            ...prev,
          ].slice(0, 6),
        );
      } finally {
        setPending(null);
      }
    },
    [nodeId],
  );

  if (nodes.error) return <ErrorNote error={nodes.error} />;
  if (!node || !signature.data) return <Loading what="node" />;

  const sig = signature.data;
  const frames = telemetry.data ?? [];
  const t0 = frames.length ? new Date(frames[0].timestamp).getTime() : Date.now();
  const xOf = (iso: string) => (new Date(iso).getTime() - t0) / 1000;

  return (
    <div className="page node-diag">
      <header className="nd-head">
        <div className="nd-ident">
          <select
            value={nodeId}
            onChange={(e) => navigate(`/nodes/${e.target.value}`)}
            aria-label="Select node"
          >
            {(nodes.data ?? []).map((n) => (
              <option key={n.node_id} value={n.node_id}>
                {n.node_id} — {n.location.label}
              </option>
            ))}
          </select>
          <span className="nd-meta">
            zone {node.zone_id} · {node.hardware_version} · fw {node.firmware_version}
          </span>
        </div>

        <div className="nd-status">
          <span className="nd-sampling" title="Current sampling mode. The software raises this on its own when evidence is thin.">
            {node.sampling_mode.replace('_', '-').toLowerCase()}
          </span>
          <span className="nd-health">
            <HealthDot health={node.health} /> {node.health}
          </span>
          <StateBadge state={node.state} />
        </div>
      </header>

      {/* --- 1. what the water is doing --- */}
      <div className="nd-row nd-physical">
        <Panel
          title="Hydraulic junction"
          subtitle="Live 3D, driven by this node's telemetry"
          className="nd-viz"
        >
          <JunctionPreview node={node} signature={sig} chrome={false} height={380} />
          <div className="nd-viz-legend">
            <span>
              <i style={{ background: 'var(--a)' }} /> inlet A
            </span>
            <span>
              <i style={{ background: 'var(--b)' }} /> inlet B
            </span>
            <span>streak length is local speed</span>
            <button type="button" className="btn ghost" onClick={() => navigate('/viz')}>
              Open full view →
            </button>
          </div>
        </Panel>

        <Panel
          title="Circumferential distribution"
          subtitle="16 channels against the stored baseline — the flow fingerprint"
          className="nd-circ"
        >
          <CircumferentialProfile features={sig.circumferential} size={210} />
        </Panel>
      </div>

      {/* --- 2. what that means against baseline --- */}
      <div className="nd-row nd-analysis">
        <Panel
          title="Flow signature"
          subtitle={`Against baseline ${sig.baseline_id}`}
          className="nd-signature"
        >
          <FlowSignatureChart signatures={history.data ?? []} height={190} />
          <MetricGrid columns={4}>
            <Metric
              label="Baseline distance"
              value={sig.baseline_distance.toFixed(3)}
              hint="L2 distance of the channel distribution from baseline, time-filtered for persistence."
              tone={
                sig.baseline_distance > 0.17
                  ? 'hot'
                  : sig.baseline_distance > 0.035
                    ? 'warn'
                    : 'ok'
              }
            />
            <Metric
              label="Rate of change"
              value={`${sig.temporal.rate_of_change >= 0 ? '+' : ''}${(sig.temporal.rate_of_change * 1000).toFixed(1)}`}
              hint="Change in baseline distance per second, ×1000."
            />
            <Metric
              label="Persistence"
              value={`${Math.round(sig.temporal.persistence * 100)}%`}
              hint="Fraction of the recent window at or above DRIFT."
            />
            <Metric
              label="Confidence"
              value={sig.confidence.toFixed(2)}
              tone={sig.confidence < 0.7 ? 'warn' : undefined}
            />
          </MetricGrid>
        </Panel>

        <Panel title="State machine" className="nd-state">
          <ol className="state-ladder">
            {(['STABLE', 'DRIFT', 'PRE_DISTURBANCE', 'DISTURBANCE'] as const).map((s) => (
              <li
                key={s}
                className={`${STATE_CLASS[s]} ${s === node.state ? 'current' : ''}`}
              >
                <i />
                <span>{STATE_LABEL[s]}</span>
                {s === node.state && <b>now</b>}
              </li>
            ))}
          </ol>
          <dl className="nd-state-facts">
            <div>
              <dt>Swirl number</dt>
              <dd>{sig.hydraulic.swirl_number.toFixed(2)}</dd>
            </div>
            <div>
              <dt>Core deficit</dt>
              <dd className={sig.hydraulic.axial_deficit > 1 ? 'hot' : undefined}>
                {sig.hydraulic.axial_deficit.toFixed(2)}
                {sig.hydraulic.axial_deficit > 1 && <em> recirculating</em>}
              </dd>
            </div>
            <div>
              <dt>Anomaly score</dt>
              <dd>{node.anomaly_score.toFixed(2)}</dd>
            </div>
            <div>
              <dt>Window</dt>
              <dd>
                {clockTime(sig.window_start)}–{clockTime(sig.window_end)}
              </dd>
            </div>
          </dl>
        </Panel>
      </div>

      {/* --- 3. why the software believes it --- */}
      <div className="nd-row nd-assessment">
        <AssessmentPanel
          signature={sig}
          state={node.state}
          upstream={neighbours.upstream}
          downstream={neighbours.downstream}
          nodeId={node.node_id}
        />
      </div>

      {/* --- 4. raw traces --- */}
      <div className="nd-row nd-traces">
        <Panel title="Flow and pressure" subtitle="Both branches and the outlet">
          {frames.length > 1 ? (
            <>
              <TimeSeriesChart
                height={150}
                unit=" L/s"
                series={[
                  {
                    id: 'a',
                    label: 'Inlet A',
                    color: 'var(--a)',
                    points: frames.map((f) => ({ x: xOf(f.timestamp), y: f.flow.a })),
                  },
                  {
                    id: 'b',
                    label: 'Inlet B',
                    color: 'var(--b)',
                    points: frames.map((f) => ({ x: xOf(f.timestamp), y: f.flow.b })),
                  },
                  {
                    id: 'out',
                    label: 'Outlet',
                    color: 'var(--ink-dim)',
                    dashed: true,
                    points: frames.map((f) => ({ x: xOf(f.timestamp), y: f.flow.out })),
                  },
                ]}
                yFormat={(v) => v.toFixed(0)}
                xFormat={(v) => clockTime(new Date(t0 + v * 1000).toISOString())}
                ariaLabel="Branch and outlet flow"
              />
              <TimeSeriesChart
                height={130}
                unit=" kPa"
                series={[
                  {
                    id: 'pa',
                    label: 'Pressure A',
                    color: 'var(--a)',
                    points: frames.map((f) => ({ x: xOf(f.timestamp), y: f.pressure.a })),
                  },
                  {
                    id: 'pb',
                    label: 'Pressure B',
                    color: 'var(--b)',
                    points: frames.map((f) => ({ x: xOf(f.timestamp), y: f.pressure.b })),
                  },
                  {
                    id: 'pout',
                    label: 'Outlet',
                    color: 'var(--ink-dim)',
                    dashed: true,
                    points: frames.map((f) => ({ x: xOf(f.timestamp), y: f.pressure.out })),
                  },
                ]}
                yFormat={(v) => v.toFixed(0)}
                ariaLabel="Branch and outlet pressure"
              />
            </>
          ) : (
            <Loading what="telemetry" />
          )}
        </Panel>

        <Panel title="Acoustic and water properties">
          {frames.length > 1 ? (
            <TimeSeriesChart
              height={150}
              series={[
                {
                  id: 'rms',
                  label: 'Acoustic RMS',
                  color: 'var(--state-pre)',
                  points: frames.map((f) => ({ x: xOf(f.timestamp), y: f.acoustic_rms })),
                },
                {
                  id: 'turb',
                  label: 'Turbidity NTU',
                  color: 'var(--state-drift)',
                  points: frames.map((f) => ({ x: xOf(f.timestamp), y: f.turbidity_ntu })),
                },
              ]}
              yFormat={(v) => v.toFixed(2)}
              xFormat={(v) => clockTime(new Date(t0 + v * 1000).toISOString())}
              ariaLabel="Acoustic and turbidity"
            />
          ) : (
            <Loading what="telemetry" />
          )}
          <MetricGrid columns={3}>
            <Metric
              label="Conductivity"
              value={sig.water_properties.conductivity.toFixed(0)}
              unit="µS/cm"
            />
            <Metric
              label="Turbidity"
              value={sig.water_properties.turbidity.toFixed(2)}
              unit="NTU"
            />
            <Metric
              label="Temperature"
              value={sig.water_properties.temperature.toFixed(1)}
              unit="°C"
            />
          </MetricGrid>
        </Panel>
      </div>

      {/* --- 5. context and control --- */}
      <div className="nd-row nd-control">
        <Panel title="Neighbouring nodes" subtitle="Upstream and downstream behaviour">
          <div className="nd-neighbours">
            <div>
              <h4>Upstream</h4>
              {node.upstream.length === 0 && <em>Source node</em>}
              {node.upstream.map((id) => {
                const n = nodes.data?.find((x) => x.node_id === id);
                return (
                  <button
                    key={id}
                    type="button"
                    className="nd-neighbour"
                    onClick={() => n && navigate(`/nodes/${id}`)}
                    disabled={!n}
                  >
                    <code>{id}</code>
                    {n ? (
                      <span className={STATE_CLASS[n.state]}>{STATE_LABEL[n.state]}</span>
                    ) : (
                      <span className="nd-src">source</span>
                    )}
                  </button>
                );
              })}
            </div>
            <div>
              <h4>Downstream</h4>
              {node.downstream.length === 0 && <em>Terminus</em>}
              {node.downstream.map((id) => {
                const n = nodes.data?.find((x) => x.node_id === id);
                return (
                  <button
                    key={id}
                    type="button"
                    className="nd-neighbour"
                    onClick={() => navigate(`/nodes/${id}`)}
                  >
                    <code>{id}</code>
                    {n && <span className={STATE_CLASS[n.state]}>{STATE_LABEL[n.state]}</span>}
                  </button>
                );
              })}
            </div>
          </div>

          <h4 className="nd-sub">Node events</h4>
          <EventTimeline
            events={events.data?.items ?? []}
            limit={4}
            chronological
            onSelect={(id) => navigate(`/events?event=${id}`)}
            emptyNote="No events raised for this node."
          />
        </Panel>

        <Panel
          title="Control"
          subtitle="Closed-loop commands · dossier §23.3"
          className="nd-commands"
        >
          <div className="cmd-group">
            <span className="cmd-label">Sampling</span>
            <div className="cmd-row">
              {SAMPLING_MODES.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={node.sampling_mode === mode ? 'btn active' : 'btn'}
                  disabled={pending !== null}
                  onClick={() =>
                    issue(`sampling:${mode}`, () =>
                      client.commandSampling(nodeId, { mode, duration_sec: 180 }),
                    )
                  }
                >
                  {mode.replace('_', '-').toLowerCase()}
                </button>
              ))}
            </div>
          </div>

          <div className="cmd-group">
            <span className="cmd-label">Capture</span>
            <div className="cmd-row">
              <button
                type="button"
                className="btn"
                disabled={pending !== null}
                onClick={() =>
                  issue('raw-window', () =>
                    client.commandRawWindow(nodeId, { window_sec: 10 }),
                  )
                }
              >
                raw window 10 s
              </button>
              <button
                type="button"
                className="btn"
                disabled={pending !== null}
                onClick={() =>
                  issue('diagnostics', () =>
                    client.commandDiagnostics(nodeId, { suite: 'QUICK' }),
                  )
                }
              >
                quick diagnostics
              </button>
              <button
                type="button"
                className="btn"
                disabled={pending !== null}
                onClick={() =>
                  issue('config', () => client.commandConfig(nodeId, { report_hz: 2 }))
                }
              >
                set report 2 Hz
              </button>
            </div>
          </div>

          {pending && (
            <p className="cmd-pending">
              <span className="spinner" /> awaiting acknowledgement — {pending}
            </p>
          )}

          <h4 className="nd-sub">Command log</h4>
          {log.length === 0 ? (
            <div className="empty">No commands issued this session.</div>
          ) : (
            <ul className="cmd-log">
              {log.map((ack, i) => (
                <li key={`${ack.command_id}-${i}`} className={ack.accepted ? 'ok' : 'fail'}>
                  <code>{ack.command_id}</code>
                  <span>{ack.accepted ? 'acknowledged' : 'not acknowledged'}</span>
                  <em>
                    {ack.detail ??
                      (ack.acknowledged_at
                        ? `${Math.max(
                            0,
                            new Date(ack.acknowledged_at).getTime() -
                              new Date(ack.issued_at).getTime(),
                          )} ms`
                        : '')}
                  </em>
                </li>
              ))}
            </ul>
          )}

          {health.data && (
            <>
              <h4 className="nd-sub">Hardware</h4>
              <dl className="nd-health-grid">
                <div>
                  <dt>Sensors</dt>
                  <dd>{health.data.sensor_status}</dd>
                </div>
                <div>
                  <dt>Comms</dt>
                  <dd>{health.data.communication_status}</dd>
                </div>
                <div>
                  <dt>Packet loss</dt>
                  <dd>{(health.data.packet_loss * 100).toFixed(1)}%</dd>
                </div>
                <div>
                  <dt>Telemetry age</dt>
                  <dd>{health.data.telemetry_age_sec.toFixed(1)} s</dd>
                </div>
                <div>
                  <dt>Calibration</dt>
                  <dd>{health.data.calibration_status}</dd>
                </div>
                <div>
                  <dt>Last seen</dt>
                  <dd>{relativeTime(node.last_seen)}</dd>
                </div>
              </dl>
            </>
          )}
        </Panel>
      </div>
    </div>
  );
}
