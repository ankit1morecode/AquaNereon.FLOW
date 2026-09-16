import { useMemo, useState } from 'react';
import type { FlowState, NetworkGraph, NodeId, NodeSummary, WaterEvent } from '../../types';
import { STATE_LABEL } from '../ui';

/**
 * The hydraulic network, drawn as a schematic.
 *
 * Deliberately not a street map. The dossier is explicit that the digital twin
 * is a computational graph rather than a geographic rendering (§12), and for
 * the question this view has to answer — did this disturbance come from
 * upstream, and what is downstream of it — a schematic beats pins on tiles.
 * Upstream/downstream reads as direction on the page, and no tile server is
 * involved.
 *
 * Pipes carry an animated flow direction whose speed follows the node's actual
 * throughput, so a starved branch visibly slows rather than needing a label.
 */

const STATE_COLOR: Record<FlowState, string> = {
  STABLE: 'var(--state-stable)',
  DRIFT: 'var(--state-drift)',
  PRE_DISTURBANCE: 'var(--state-pre)',
  DISTURBANCE: 'var(--state-disturbance)',
};

export interface NetworkMapProps {
  network: NetworkGraph;
  nodes: NodeSummary[];
  events?: WaterEvent[];
  selected?: NodeId | null;
  onSelect?: (nodeId: NodeId) => void;
  /** Dim everything outside this zone. */
  focusZone?: string | null;
  height?: number;
}

export function NetworkMap({
  network,
  nodes,
  events = [],
  selected = null,
  onSelect,
  focusZone = null,
  height = 420,
}: NetworkMapProps) {
  const W = 1000;
  const H = 680;
  const [hovered, setHovered] = useState<string | null>(null);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.node_id, n])), [nodes]);
  const openByNode = useMemo(() => {
    const map = new Map<NodeId, WaterEvent[]>();
    for (const e of events) {
      if (e.status === 'CLOSED') continue;
      const list = map.get(e.node_id) ?? [];
      list.push(e);
      map.set(e.node_id, list);
    }
    return map;
  }, [events]);

  const px = (v: number) => 40 + v * (W - 80);
  const py = (v: number) => 34 + v * (H - 80);

  /** Soft zone hulls, so membership reads without boxing the diagram in. */
  const zoneBlobs = useMemo(
    () =>
      network.zones.map((zone) => {
        const members = network.vertices.filter((v) => v.zone_id === zone.zone_id);
        if (members.length === 0) return null;
        const xs = members.map((m) => px(m.location.x));
        const ys = members.map((m) => py(m.location.y));
        const pad = 52;
        return {
          zone,
          x: Math.min(...xs) - pad,
          y: Math.min(...ys) - pad,
          w: Math.max(...xs) - Math.min(...xs) + pad * 2,
          h: Math.max(...ys) - Math.min(...ys) + pad * 2,
        };
      }),
    [network],
  );

  return (
    <div className="network-map" style={{ height }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
        <defs>
          <marker
            id="nm-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" fill="rgba(140,190,215,0.5)" />
          </marker>
        </defs>

        {/* zones */}
        {zoneBlobs.map(
          (blob) =>
            blob && (
              <g key={blob.zone.zone_id} opacity={focusZone && focusZone !== blob.zone.zone_id ? 0.25 : 1}>
                <rect
                  x={blob.x}
                  y={blob.y}
                  width={blob.w}
                  height={blob.h}
                  rx={26}
                  className="nm-zone"
                />
                <text x={blob.x + 14} y={blob.y + 22} className="nm-zone-label">
                  {blob.zone.name}
                </text>
              </g>
            ),
        )}

        {/* pipes */}
        {network.edges.map((edge) => {
          const from = network.vertices.find((v) => v.id === edge.from);
          const to = network.vertices.find((v) => v.id === edge.to);
          if (!from || !to) return null;

          const downstream = byId.get(edge.to);
          const load = downstream ? downstream.flow_lps / Math.max(edge.nominal_flow_lps, 1) : 0.6;
          const dim = focusZone && to.zone_id !== focusZone && from.zone_id !== focusZone;
          // Dash animation period shortens as throughput rises, so a starved
          // branch is visibly slow rather than merely labelled as one.
          const period = Math.max(0.7, 4.5 - load * 3.2);

          return (
            <g key={edge.pipe_id} opacity={dim ? 0.22 : 1}>
              <line
                x1={px(from.location.x)}
                y1={py(from.location.y)}
                x2={px(to.location.x)}
                y2={py(to.location.y)}
                className="nm-pipe"
                strokeWidth={2 + (edge.diameter_mm / 260) * 4}
                markerEnd="url(#nm-arrow)"
              />
              <line
                x1={px(from.location.x)}
                y1={py(from.location.y)}
                x2={px(to.location.x)}
                y2={py(to.location.y)}
                className="nm-flow"
                strokeWidth={1.6}
                style={{ animationDuration: `${period}s` }}
              />
            </g>
          );
        })}

        {/* vertices */}
        {network.vertices.map((vertex) => {
          const summary = byId.get(vertex.id);
          const dim = focusZone !== null && vertex.zone_id !== focusZone;
          const open = openByNode.get(vertex.id);
          const isSelected = selected === vertex.id;
          const x = px(vertex.location.x);
          const y = py(vertex.location.y);

          if (vertex.kind !== 'JUNCTION') {
            return (
              <g key={vertex.id} opacity={dim ? 0.3 : 1} className="nm-source">
                <rect x={x - 13} y={y - 13} width={26} height={26} rx={7} />
                <text x={x} y={y + 30} textAnchor="middle" className="nm-label">
                  {vertex.location.label}
                </text>
              </g>
            );
          }

          const color = summary ? STATE_COLOR[summary.state] : 'var(--ink-faint)';
          const offline = summary?.health === 'OFFLINE';

          return (
            <g
              key={vertex.id}
              className={`nm-node ${isSelected ? 'selected' : ''}`}
              opacity={dim ? 0.3 : 1}
              onClick={() => onSelect?.(vertex.id)}
              onPointerEnter={() => setHovered(vertex.id)}
              onPointerLeave={() => setHovered(null)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') onSelect?.(vertex.id);
              }}
            >
              {open && open.length > 0 && (
                <circle cx={x} cy={y} r={22} fill="none" stroke={color} className="nm-alert" />
              )}
              {isSelected && <circle cx={x} cy={y} r={17} className="nm-ring" />}
              <circle cx={x} cy={y} r={10} fill={color} className="nm-dot" />
              {offline && <circle cx={x} cy={y} r={10} className="nm-offline" />}
              <text x={x} y={y - 18} textAnchor="middle" className="nm-id">
                {vertex.id.replace('AN-J-', 'J')}
              </text>
              {(hovered === vertex.id || isSelected) && summary && (
                <g className="nm-tip" transform={`translate(${x + 16}, ${y + 8})`}>
                  <rect width={168} height={54} rx={7} />
                  <text x={10} y={18}>{vertex.location.label}</text>
                  <text x={10} y={34} className="nm-tip-sub">
                    {STATE_LABEL[summary.state]} · {summary.flow_lps.toFixed(1)} L/s
                  </text>
                  <text x={10} y={47} className="nm-tip-sub">
                    anomaly {summary.anomaly_score.toFixed(2)} · {summary.sampling_mode}
                  </text>
                </g>
              )}
            </g>
          );
        })}
      </svg>

      <ul className="nm-legend">
        {(['STABLE', 'DRIFT', 'PRE_DISTURBANCE', 'DISTURBANCE'] as FlowState[]).map((s) => (
          <li key={s}>
            <i style={{ background: STATE_COLOR[s] }} />
            {STATE_LABEL[s]}
          </li>
        ))}
      </ul>
    </div>
  );
}
