import { describe, expect, it } from 'vitest';
import { assess, severityForState } from '../src/services/assessment';
import { propagationPath, suspectRegion } from '../src/services/propagation';
import { zoneHull, haversineMetres } from '../src/services/topology';
import { PlatformSimulator } from '../src/services/platformSimulator';
import type { FlowSignature, FlowState, NodeSummary } from '../src/types';

/**
 * Tests for the reasoning the interface displays.
 *
 * These cover the things a screen asserts about a node — why it is in the
 * state it is in, where a disturbance came from, which stretch of pipe is
 * implicated. Getting any of them wrong produces a confident, wrong
 * explanation, which is worse than showing nothing.
 */

function signature(over: Partial<FlowSignature> = {}): FlowSignature {
  const base: FlowSignature = {
    signature_id: 'SIG-TEST',
    node_id: 'AN-J-014',
    timestamp: new Date().toISOString(),
    window_start: new Date().toISOString(),
    window_end: new Date().toISOString(),
    hydraulic: {
      flow_mean: 24,
      flow_variation: 0.2,
      pressure_mean: 310,
      pressure_variation: 2,
      swirl_number: 0.45,
      axial_deficit: 0.19,
    },
    acoustic: { rms: 0.05, peak: 0.1, dominant_hz: 340, spectral_energy: 0.1 },
    circumferential: {
      channel_features: new Array(16).fill(1),
      distribution_vector: new Array(16).fill(1),
      asymmetry: 0.004,
      sector_imbalance: 0.05,
      spatial_gradient: 0.01,
      modes: [0.01, 0.01, 0.005],
      mode1_phase: 0,
    },
    water_properties: { conductivity: 412, turbidity: 0.3, temperature: 21 },
    temporal: { rate_of_change: 0, persistence: 0, drift: 0, sudden_deviation: 0 },
    baseline_id: 'balanced-1000',
    baseline_distance: 0.004,
    confidence: 0.95,
    data_quality: { completeness: 1, confidence: 0.95, stale: false, suspect_channels: [] },
    state: 'STABLE',
    ...over,
  };
  return base;
}

function node(id: string, state: FlowState, anomaly: number, upstream: string[] = []): NodeSummary {
  return {
    node_id: id,
    zone_id: 'Z-TEST',
    hardware_version: 'x',
    firmware_version: 'x',
    location: { lat: 0, lng: 0, label: id },
    nominal_flow_lps: 24,
    upstream,
    downstream: [],
    commissioned_at: '',
    state,
    health: 'OK',
    anomaly_score: anomaly,
    flow_lps: 24,
    sampling_mode: 'NORMAL',
    last_seen: new Date().toISOString(),
  };
}

describe('assessment', () => {
  it('produces every evidence kind the dossier requires', () => {
    const { evidence } = assess({
      signature: signature(),
      state: 'STABLE',
      upstream: [],
      downstream: [],
    });
    const kinds = new Set(evidence.map((e) => e.kind));
    expect(kinds).toEqual(
      new Set([
        'SIGNATURE_DEVIATION',
        'SENSOR',
        'RATE_OF_CHANGE',
        'PERSISTENCE',
        'NEIGHBOUR',
        'DATA_QUALITY',
      ]),
    );
  });

  it('keeps every weight inside 0..1, whatever the input', () => {
    // A weight outside the range would render as a meter overflowing its
    // track, which reads as a broken component rather than a strong signal.
    const extreme = assess({
      signature: signature({
        baseline_distance: 99,
        circumferential: {
          ...signature().circumferential,
          asymmetry: 50,
          sector_imbalance: 90,
        },
        temporal: { rate_of_change: -80, persistence: 5, drift: 9, sudden_deviation: 3 },
        hydraulic: { ...signature().hydraulic, axial_deficit: 40 },
        data_quality: { completeness: 0, confidence: -2, stale: true, suspect_channels: [] },
      }),
      state: 'DISTURBANCE',
      upstream: [],
      downstream: [],
    });
    for (const item of extreme.evidence) {
      expect(item.weight).toBeGreaterThanOrEqual(0);
      expect(item.weight).toBeLessThanOrEqual(1);
    }
  });

  it('survives non-finite values without emitting NaN into the UI', () => {
    const { evidence } = assess({
      signature: signature({ baseline_distance: Number.NaN }),
      state: 'DRIFT',
      upstream: [],
      downstream: [],
    });
    for (const item of evidence) expect(Number.isFinite(item.weight)).toBe(true);
  });

  it('reports propagation when an upstream node is disturbed', () => {
    const local = assess({
      signature: signature(),
      state: 'DRIFT',
      upstream: [{ node_id: 'AN-J-011', state: 'STABLE' }],
      downstream: [],
    });
    expect(local.propagated).toBe(false);
    expect(local.eventType).toBe('FLOW_ANOMALY');

    const propagated = assess({
      signature: signature(),
      state: 'DRIFT',
      upstream: [{ node_id: 'AN-J-011', state: 'DISTURBANCE' }],
      downstream: [],
    });
    expect(propagated.propagated).toBe(true);
    expect(propagated.eventType).toBe('NETWORK_EVENT');
  });

  it('suspects loss only when the pattern is one-sided, persistent and unexplained', () => {
    const leaky = signature({
      circumferential: { ...signature().circumferential, asymmetry: 0.09 },
      temporal: { rate_of_change: 0.01, persistence: 0.8, drift: 0.2, sudden_deviation: 0 },
    });

    expect(
      assess({ signature: leaky, state: 'DISTURBANCE', upstream: [], downstream: [] })
        .leakSuspected,
    ).toBe(true);

    // Upstream explains it, so this is propagation rather than loss.
    expect(
      assess({
        signature: leaky,
        state: 'DISTURBANCE',
        upstream: [{ node_id: 'up', state: 'DRIFT' }],
        downstream: [],
      }).leakSuspected,
    ).toBe(false);

    // Not persistent: a transient, not a developing loss.
    expect(
      assess({
        signature: signature({
          circumferential: { ...signature().circumferential, asymmetry: 0.09 },
        }),
        state: 'DISTURBANCE',
        upstream: [],
        downstream: [],
      }).leakSuspected,
    ).toBe(false);

    // A stable node never suspects a leak, however the numbers land.
    expect(
      assess({ signature: leaky, state: 'STABLE', upstream: [], downstream: [] })
        .leakSuspected,
    ).toBe(false);
  });

  it('names the downstream node in the leak prediction when there is one', () => {
    const leaky = signature({
      circumferential: { ...signature().circumferential, asymmetry: 0.09 },
      temporal: { rate_of_change: 0, persistence: 0.8, drift: 0.2, sudden_deviation: 0 },
    });
    const withDownstream = assess({
      signature: leaky,
      state: 'DISTURBANCE',
      upstream: [],
      downstream: [{ node_id: 'AN-J-017', state: 'STABLE' }],
    });
    expect(withDownstream.modelOutputs.some((m) => m.prediction.includes('AN-J-017'))).toBe(
      true,
    );

    // A terminus has nothing downstream to name, and must not say "undefined".
    const terminus = assess({
      signature: leaky,
      state: 'DISTURBANCE',
      upstream: [],
      downstream: [],
    });
    for (const m of terminus.modelOutputs) {
      expect(m.prediction).not.toContain('undefined');
    }
  });

  it('explains a stable reading rather than going silent', () => {
    const { modelOutputs } = assess({
      signature: signature(),
      state: 'STABLE',
      upstream: [],
      downstream: [],
    });
    expect(modelOutputs).toHaveLength(1);
    expect(modelOutputs[0].explanation.join(' ')).toMatch(/matches the stored baseline/i);
  });

  it('maps each state to an escalating severity', () => {
    expect(severityForState('STABLE')).toBe('INFO');
    expect(severityForState('DRIFT')).toBe('LOW');
    expect(severityForState('PRE_DISTURBANCE')).toBe('MEDIUM');
    expect(severityForState('DISTURBANCE')).toBe('HIGH');
  });
});

describe('propagation path', () => {
  const platform = new PlatformSimulator();
  const network = platform.network;

  it('reports a single-node path as local', () => {
    const nodes = [...platform.nodes.values()].map((n) =>
      node(n.node.node_id, 'STABLE', 0, n.node.upstream),
    );
    const result = propagationPath(network, nodes, 'AN-J-014');
    expect(result.path).toEqual(['AN-J-014']);
    expect(result.local).toBe(true);
    expect(result.pipes).toHaveLength(0);
  });

  it('walks upstream for as long as the feeders are disturbed', () => {
    const disturbed = new Set(['AN-J-014', 'AN-J-011', 'AN-J-005']);
    const nodes = [...platform.nodes.values()].map((n) =>
      node(
        n.node.node_id,
        disturbed.has(n.node.node_id) ? 'DISTURBANCE' : 'STABLE',
        disturbed.has(n.node.node_id) ? 0.8 : 0,
        n.node.upstream,
      ),
    );

    const result = propagationPath(network, nodes, 'AN-J-014');
    expect(result.local).toBe(false);
    // Ordered from the furthest disturbed ancestor down to the origin node.
    expect(result.path[result.path.length - 1]).toBe('AN-J-014');
    expect(result.path).toContain('AN-J-011');
    expect(result.path).toContain('AN-J-005');
    expect(result.pipes.length).toBe(result.path.length - 1);
  });

  it('stops at the first stable feeder', () => {
    const disturbed = new Set(['AN-J-014', 'AN-J-011']);
    const nodes = [...platform.nodes.values()].map((n) =>
      node(
        n.node.node_id,
        disturbed.has(n.node.node_id) ? 'DRIFT' : 'STABLE',
        0.4,
        n.node.upstream,
      ),
    );
    const result = propagationPath(network, nodes, 'AN-J-014');
    expect(result.path).toEqual(['AN-J-011', 'AN-J-014']);
  });

  it('follows the more anomalous feeder when two are disturbed', () => {
    // AN-J-011 is fed by both AN-J-005 and AN-J-034.
    const nodes = [...platform.nodes.values()].map((n) => {
      const id = n.node.node_id;
      const anomaly = id === 'AN-J-034' ? 0.9 : id === 'AN-J-005' ? 0.4 : 0.5;
      const state: FlowState =
        id === 'AN-J-011' || id === 'AN-J-005' || id === 'AN-J-034' ? 'DRIFT' : 'STABLE';
      return node(id, state, anomaly, n.node.upstream);
    });
    const result = propagationPath(network, nodes, 'AN-J-011');
    expect(result.path).toContain('AN-J-034');
    expect(result.path).not.toContain('AN-J-005');
  });

  it('terminates on a cycle rather than hanging the interface', () => {
    const cyclic = {
      ...network,
      edges: [
        { pipe_id: 'P-A-B', from: 'A', to: 'B', diameter_mm: 100, length_m: 10, nominal_flow_lps: 1, nominal_pressure_kpa: 1 },
        { pipe_id: 'P-B-A', from: 'B', to: 'A', diameter_mm: 100, length_m: 10, nominal_flow_lps: 1, nominal_pressure_kpa: 1 },
      ],
    };
    const nodes = [node('A', 'DRIFT', 0.5, ['B']), node('B', 'DRIFT', 0.5, ['A'])];
    const result = propagationPath(cyclic, nodes, 'A');
    expect(result.path.length).toBeLessThanOrEqual(2);
  });

  it('respects the disturbance threshold', () => {
    const nodes = [...platform.nodes.values()].map((n) =>
      node(n.node.node_id, 'DRIFT', 0.4, n.node.upstream),
    );
    // At DRIFT everything upstream qualifies; at DISTURBANCE nothing does.
    expect(propagationPath(network, nodes, 'AN-J-014', 'DRIFT').local).toBe(false);
    expect(propagationPath(network, nodes, 'AN-J-014', 'DISTURBANCE').local).toBe(true);
  });
});

describe('suspect region', () => {
  const platform = new PlatformSimulator();

  it('implicates the run downstream of the node, not the node itself', () => {
    const region = suspectRegion(platform.network, 'AN-J-014');
    expect(region.pipes.length).toBeGreaterThan(0);
    for (const pipeId of region.pipes) {
      const edge = platform.network.edges.find((e) => e.pipe_id === pipeId);
      expect(edge?.from).toBe('AN-J-014');
    }
    expect(region.description).toContain('AN-J-014');
  });

  it('says so plainly when the node feeds nothing instrumented', () => {
    const region = suspectRegion(platform.network, 'AN-J-027');
    expect(region.pipes).toHaveLength(0);
    expect(region.description).toMatch(/beyond the instrumented network/i);
  });
});

describe('topology helpers', () => {
  it('measures a known distance correctly', () => {
    // One degree of latitude is close to 111 km anywhere.
    const d = haversineMetres(
      { lat: 55, lng: -1.6, label: '' },
      { lat: 56, lng: -1.6, label: '' },
    );
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });

  it('encloses every point it was given', () => {
    const points = [
      { lat: 55.0, lng: -1.7 },
      { lat: 55.1, lng: -1.5 },
      { lat: 54.9, lng: -1.6 },
      { lat: 55.02, lng: -1.62 },
    ];
    const hull = zoneHull(points);
    expect(hull.length).toBeGreaterThanOrEqual(3);

    const lats = hull.map((p) => p[0]);
    const lngs = hull.map((p) => p[1]);
    for (const p of points) {
      expect(p.lat).toBeGreaterThanOrEqual(Math.min(...lats));
      expect(p.lat).toBeLessThanOrEqual(Math.max(...lats));
      expect(p.lng).toBeGreaterThanOrEqual(Math.min(...lngs));
      expect(p.lng).toBeLessThanOrEqual(Math.max(...lngs));
    }
  });

  it('still returns something drawable for one or two points', () => {
    expect(zoneHull([]).length).toBe(0);
    expect(zoneHull([{ lat: 55, lng: -1.6 }]).length).toBeGreaterThanOrEqual(3);
    expect(
      zoneHull([
        { lat: 55, lng: -1.6 },
        { lat: 55.1, lng: -1.5 },
      ]).length,
    ).toBeGreaterThanOrEqual(3);
  });
});
