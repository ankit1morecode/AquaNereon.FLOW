import type { FlowState, NetworkGraph, NodeId, NodeSummary } from '../types';

/**
 * Where a disturbance came from, and where the loss might be.
 *
 * The dossier asks for propagation-path analysis (§12.1) and a candidate leak
 * region (§18), and both are spatial claims — an event that says "PROPAGATED"
 * without showing the path is asking to be taken on trust. These compute the
 * geometry so the map can draw it.
 *
 * Pure functions over the graph and the current node states, so they can be
 * tested directly rather than only through a rendered map.
 */

export interface PropagationResult {
  /**
   * Nodes on the path, ordered from the furthest disturbed ancestor down to
   * the node the event was raised on. A single entry means the disturbance is
   * local — nothing upstream of it is misbehaving.
   */
  path: NodeId[];
  /** Pipe ids along that path. */
  pipes: string[];
  local: boolean;
}

/**
 * Walk upstream from a node for as long as its feeders are also disturbed.
 *
 * This is the question an operator asks first: is this node the origin, or is
 * it downstream of something else? Following the chain of non-STABLE feeders
 * answers it directly. Where a node has two disturbed feeders the more
 * anomalous one is followed, because that is the more likely origin and a
 * branching highlight would be unreadable.
 */
export function propagationPath(
  network: NetworkGraph,
  nodes: NodeSummary[],
  originNodeId: NodeId,
  /** Treat anything at or above this state as disturbed. */
  threshold: FlowState = 'DRIFT',
): PropagationResult {
  const order: FlowState[] = ['STABLE', 'DRIFT', 'PRE_DISTURBANCE', 'DISTURBANCE'];
  const minIndex = order.indexOf(threshold);
  const byId = new Map(nodes.map((n) => [n.node_id, n]));

  const disturbed = (id: NodeId) => {
    const node = byId.get(id);
    return node ? order.indexOf(node.state) >= minIndex : false;
  };

  const path: NodeId[] = [originNodeId];
  const seen = new Set<NodeId>([originNodeId]);
  let cursor = originNodeId;

  // Bounded by the node count: a cycle in the graph must not hang the UI.
  for (let step = 0; step < nodes.length; step++) {
    const node = byId.get(cursor);
    if (!node) break;

    const candidates = node.upstream
      .filter((id) => !seen.has(id) && disturbed(id))
      .map((id) => byId.get(id))
      .filter((n): n is NodeSummary => Boolean(n));

    if (candidates.length === 0) break;

    // Follow the worst one: with two disturbed feeders, the more anomalous is
    // the likelier origin, and drawing both would make the path unreadable.
    const next = candidates.reduce((worst, n) =>
      n.anomaly_score > worst.anomaly_score ? n : worst,
    );

    path.unshift(next.node_id);
    seen.add(next.node_id);
    cursor = next.node_id;
  }

  const pipes: string[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const edge = network.edges.find((e) => e.from === path[i] && e.to === path[i + 1]);
    if (edge) pipes.push(edge.pipe_id);
  }

  return { path, pipes, local: path.length === 1 };
}

export interface SuspectRegion {
  /** Pipes between the node and everything it feeds. */
  pipes: string[];
  /** The stretch as a human sentence, for the event's suspected origin. */
  description: string;
}

/**
 * The stretch of network a suspected loss would be in.
 *
 * A ring reports what passes it, not what leaks after it, so a one-sided
 * pattern with no upstream correlate implicates the run *downstream* of the
 * node — between it and whatever it feeds. That is a region, not a point, and
 * saying so is more honest than dropping a pin.
 */
export function suspectRegion(
  network: NetworkGraph,
  nodeId: NodeId,
): SuspectRegion {
  const pipes = network.edges.filter((e) => e.from === nodeId);
  const targets = pipes.map((p) => p.to);

  const description = targets.length
    ? `Between ${nodeId} and ${targets.join(' / ')}`
    : `Downstream of ${nodeId}, beyond the instrumented network`;

  return { pipes: pipes.map((p) => p.pipe_id), description };
}
