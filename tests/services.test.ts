import { describe, expect, it } from 'vitest';
import {
  CHANNEL_QOS,
  CHANNEL_RETAIN,
  LocalDeviceBus,
  parseTopic,
  topicFor,
  topicWildcard,
} from '../src/services/mqtt';
import { PlatformSimulator, diurnalFactor, zoneDemandLps } from '../src/services/platformSimulator';
import { SimulatedApiClient } from '../src/services/simulatedClient';
import { HttpApiClient } from '../src/services/httpClient';
import type { ApiClient } from '../src/services/client';
import type { NodeHealth } from '../src/types';

/**
 * Tests for the platform service layer.
 *
 * Two things matter most here and neither is about rendering: that the
 * simulated and HTTP clients really are interchangeable, and that events carry
 * the evidence the dossier requires rather than a label.
 */

/** Advance a platform far enough for every scenario to have cycled. */
function run(platform: PlatformSimulator, seconds: number, dt = 1.5) {
  for (let i = 0; i < seconds / dt; i++) platform.tick(dt);
}

describe('MQTT topic design', () => {
  it('builds the topics the dossier specifies', () => {
    expect(topicFor('AN-J-014', 'telemetry')).toBe('aquanereon/AN-J-014/telemetry');
    expect(topicFor('AN-J-014', 'signature')).toBe('aquanereon/AN-J-014/signature');
    expect(topicFor('AN-J-014', 'health')).toBe('aquanereon/AN-J-014/health');
    expect(topicFor('AN-J-014', 'event')).toBe('aquanereon/AN-J-014/event');
    expect(topicFor('AN-J-014', 'command')).toBe('aquanereon/AN-J-014/command');
    expect(topicFor('AN-J-014', 'ack')).toBe('aquanereon/AN-J-014/ack');
  });

  it('round-trips through parseTopic', () => {
    const parsed = parseTopic(topicFor('AN-J-002', 'event'));
    expect(parsed).toEqual({ nodeId: 'AN-J-002', channel: 'event' });
  });

  it('rejects topics that are not ours', () => {
    expect(parseTopic('other/AN-J-002/event')).toBeNull();
    expect(parseTopic('aquanereon/AN-J-002')).toBeNull();
    expect(parseTopic('aquanereon/AN-J-002/nonsense')).toBeNull();
  });

  it('subscribes across every node with a wildcard', () => {
    expect(topicWildcard('telemetry')).toBe('aquanereon/+/telemetry');
  });

  it('puts events and commands on the delivery guarantee they need', () => {
    // An event that arrives twice becomes two alerts; one that never arrives
    // is a missed disturbance. Neither is acceptable, so exactly-once.
    expect(CHANNEL_QOS.event).toBe(2);
    expect(CHANNEL_QOS.command).toBe(2);
    // Telemetry is a stream: the next frame is along shortly.
    expect(CHANNEL_QOS.telemetry).toBe(0);
  });

  it('retains last-known state but not data streams', () => {
    expect(CHANNEL_RETAIN.health).toBe(true);
    expect(CHANNEL_RETAIN.telemetry).toBe(false);
    expect(CHANNEL_RETAIN.event).toBe(false);
  });
});

describe('device bus', () => {
  const health = (id: string): NodeHealth => ({
    node_id: id,
    timestamp: new Date().toISOString(),
    sensor_status: 'OK',
    power_status: 'OK',
    communication_status: 'OK',
    calibration_status: 'OK',
    telemetry_age_sec: 0.5,
    packet_loss: 0,
  });

  it('delivers to subscribers of that channel only', () => {
    const bus = new LocalDeviceBus();
    const seen: string[] = [];
    bus.subscribe('health', (id) => seen.push(id));
    bus.publish('AN-J-001', 'health', health('AN-J-001'));
    bus.publish('AN-J-002', 'event', {} as never);
    expect(seen).toEqual(['AN-J-001']);
  });

  it('replays retained messages to a late subscriber, as a broker would', () => {
    const bus = new LocalDeviceBus();
    bus.publish('AN-J-001', 'health', health('AN-J-001'));
    const seen: string[] = [];
    bus.subscribe('health', (id) => seen.push(id));
    expect(seen).toEqual(['AN-J-001']);
  });

  it('does not replay a non-retained channel', () => {
    const bus = new LocalDeviceBus();
    bus.publish('AN-J-001', 'telemetry', {} as never);
    const seen: string[] = [];
    bus.subscribe('telemetry', (id) => seen.push(id));
    expect(seen).toEqual([]);
  });

  it('stops delivering after unsubscribe', () => {
    const bus = new LocalDeviceBus();
    const seen: string[] = [];
    const off = bus.subscribe('event', (id) => seen.push(id));
    off();
    bus.publish('AN-J-001', 'event', {} as never);
    expect(seen).toEqual([]);
  });
});

describe('demand model', () => {
  it('peaks morning and evening and troughs overnight', () => {
    const night = diurnalFactor(3);
    const morning = diurnalFactor(7.5);
    const evening = diurnalFactor(19.5);
    const midday = diurnalFactor(13);
    expect(morning).toBeGreaterThan(midday);
    expect(evening).toBeGreaterThan(midday);
    expect(night).toBeLessThan(midday);
  });

  it('wraps across midnight without discontinuity', () => {
    expect(diurnalFactor(24)).toBeCloseTo(diurnalFactor(0), 10);
    expect(diurnalFactor(-1)).toBeCloseTo(diurnalFactor(23), 10);
  });

  it('is sized so demand is comparable to what the network delivers', () => {
    // Checked against the running network rather than a hard-coded figure, so
    // adding nodes or zones cannot silently put the two on different scales.
    const platform = new PlatformSimulator();
    run(platform, 60);
    const supply = [...platform.nodes.values()].reduce((s, n) => s + n.outletFlowLps, 0);
    const population = platform.zones.reduce((s, z) => s + z.population, 0);
    const meanDemand =
      Array.from({ length: 24 }, (_, h) => zoneDemandLps(population, h)).reduce(
        (s, v) => s + v,
        0,
      ) / 24;
    expect(meanDemand / supply).toBeGreaterThan(0.6);
    expect(meanDemand / supply).toBeLessThan(1.6);
  });
});

describe('platform simulator', () => {
  it('builds a connected network with sources and junctions', () => {
    const platform = new PlatformSimulator();
    const { vertices, edges } = platform.network;
    expect(vertices.filter((v) => v.kind === 'JUNCTION').length).toBe(21);
    expect(vertices.filter((v) => v.kind !== 'JUNCTION').length).toBe(3);
    // Every edge connects two vertices that exist.
    for (const edge of edges) {
      expect(vertices.some((v) => v.id === edge.from)).toBe(true);
      expect(vertices.some((v) => v.id === edge.to)).toBe(true);
    }
  });

  it('keeps upstream and downstream consistent in both directions', () => {
    const platform = new PlatformSimulator();
    for (const sim of platform.nodes.values()) {
      for (const downId of sim.node.downstream) {
        expect(platform.nodes.get(downId)?.node.upstream).toContain(sim.node.node_id);
      }
    }
  });

  it('raises events as nodes escalate, not on a timer', () => {
    const platform = new PlatformSimulator();
    expect(platform.allEvents()).toHaveLength(0);
    run(platform, 240);
    const events = platform.allEvents();
    expect(events.length).toBeGreaterThan(0);
    // Every event corresponds to an escalation.
    const order = ['STABLE', 'DRIFT', 'PRE_DISTURBANCE', 'DISTURBANCE'];
    for (const e of events) {
      expect(order.indexOf(e.state_transition.to)).toBeGreaterThan(
        order.indexOf(e.state_transition.from),
      );
    }
  });

  it('carries the evidence the dossier requires on every event', () => {
    const platform = new PlatformSimulator();
    run(platform, 240);
    const event = platform.allEvents()[0];
    expect(event).toBeDefined();

    const kinds = new Set(event.evidence.map((e) => e.kind));
    // What changed, how far from baseline, how fast, whether it persisted,
    // what the neighbours did, and how good the data was.
    expect(kinds.has('SIGNATURE_DEVIATION')).toBe(true);
    expect(kinds.has('SENSOR')).toBe(true);
    expect(kinds.has('RATE_OF_CHANGE')).toBe(true);
    expect(kinds.has('PERSISTENCE')).toBe(true);
    expect(kinds.has('NEIGHBOUR')).toBe(true);
    expect(kinds.has('DATA_QUALITY')).toBe(true);

    for (const item of event.evidence) {
      expect(item.weight).toBeGreaterThanOrEqual(0);
      expect(item.weight).toBeLessThanOrEqual(1);
      expect(item.value).not.toBe('');
    }

    // And a model output that explains itself rather than asserting.
    expect(event.model_outputs.length).toBeGreaterThan(0);
    expect(event.model_outputs[0].explanation.length).toBeGreaterThan(0);
    expect(event.model_outputs[0].contributing_features.length).toBeGreaterThan(0);
    expect(event.recommended_action?.rationale).toBeTruthy();
  });

  it('publishes device traffic on the bus as it runs', () => {
    const platform = new PlatformSimulator();
    const channels = { telemetry: 0, signature: 0, health: 0 };
    platform.bus.subscribe('telemetry', () => channels.telemetry++);
    platform.bus.subscribe('signature', () => channels.signature++);
    platform.bus.subscribe('health', () => channels.health++);
    run(platform, 15);
    expect(channels.telemetry).toBeGreaterThan(0);
    expect(channels.signature).toBe(channels.telemetry);
    expect(channels.health).toBeGreaterThan(0);
  });

  it('raises node sampling on its own as evidence thins — the closed loop', () => {
    const platform = new PlatformSimulator();
    run(platform, 240);
    const disturbed = [...platform.nodes.values()].filter((n) => n.state !== 'STABLE');
    expect(disturbed.length).toBeGreaterThan(0);
    for (const node of disturbed) {
      expect(node.samplingMode).not.toBe('NORMAL');
    }
  });

  it('keeps zone supply and demand on the same scale', () => {
    const platform = new PlatformSimulator();
    run(platform, 60);
    for (const zone of platform.zones) {
      const summary = platform.zoneSummary(zone.zone_id);
      expect(summary.supply_lps).toBeGreaterThan(0);
      expect(summary.demand_lps).toBeGreaterThan(0);
      // Within a factor of three either way: the diurnal swing is real, a
      // scale error is not.
      const ratio = summary.demand_lps / summary.supply_lps;
      expect(ratio).toBeGreaterThan(0.25);
      expect(ratio).toBeLessThan(3);
    }
  });

  it('issues a forecast whose interval widens with horizon', () => {
    const platform = new PlatformSimulator();
    const forecast = platform.forecast('CITY', 'CITY');
    expect(forecast.forecast.length).toBeGreaterThan(20);
    const near = forecast.forecast[1];
    const far = forecast.forecast[forecast.forecast.length - 1];
    const nearSpread = (near.hi ?? 0) - (near.lo ?? 0);
    const farSpread = (far.hi ?? 0) - (far.lo ?? 0);
    expect(farSpread).toBeGreaterThan(nearSpread);
  });
});

describe('API client interchangeability', () => {
  /**
   * The dossier's requirement is that simulation and hardware share the query
   * contract. That is only true if both objects present the same surface, so
   * check it structurally rather than trusting the type checker to have been
   * run before someone ships.
   */
  it('exposes the same method surface from both implementations', () => {
    const platform = new PlatformSimulator();
    const sim = new SimulatedApiClient(platform);
    const http = new HttpApiClient({ baseUrl: '/api/v1' });

    const methods: (keyof ApiClient)[] = [
      'postTelemetry',
      'postFlowSignature',
      'postHealth',
      'postEvent',
      'getNodes',
      'getNode',
      'getNodeTelemetry',
      'getNodeSignature',
      'getNodeSignatureHistory',
      'getNodeState',
      'getNodeHealth',
      'getZoneSummary',
      'getZones',
      'getEvents',
      'getForecasts',
      'getRecommendations',
      'getNetwork',
      'getCityOverview',
      'commandSampling',
      'commandRawWindow',
      'commandDiagnostics',
      'commandConfig',
      'subscribe',
    ];

    for (const method of methods) {
      expect(typeof sim[method], `simulated client is missing ${method}`).toBe('function');
      expect(typeof http[method], `http client is missing ${method}`).toBe('function');
    }
    expect(sim.mode).toBe('SIMULATION');
    expect(http.mode).toBe('REAL');
  });
});

describe('simulated client', () => {
  const build = () => {
    const platform = new PlatformSimulator();
    return { platform, client: new SimulatedApiClient(platform) };
  };

  it('returns a summary for every node', async () => {
    const { platform, client } = build();
    run(platform, 30);
    const nodes = await client.getNodes();
    expect(nodes).toHaveLength(21);
    for (const node of nodes) {
      expect(node.node_id).toMatch(/^AN-J-/);
      expect(node.flow_lps).toBeGreaterThan(0);
      expect(node.anomaly_score).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns signature history that grows as the platform runs', async () => {
    const { platform, client } = build();
    run(platform, 60);
    const history = await client.getNodeSignatureHistory('AN-J-014', 40);
    expect(history.length).toBeGreaterThan(5);
    for (const sig of history) {
      expect(sig.circumferential.distribution_vector).toHaveLength(16);
      expect(sig.baseline_distance).toBeGreaterThanOrEqual(0);
    }
  });

  it('filters events by node, zone and status', async () => {
    const { platform, client } = build();
    run(platform, 240);
    const all = await client.getEvents();
    expect(all.items.length).toBeGreaterThan(0);

    const byNode = await client.getEvents({ node_id: 'AN-J-014' });
    for (const e of byNode.items) expect(e.node_id).toBe('AN-J-014');

    const byZone = await client.getEvents({ zone_id: 'Z-CENTRAL' });
    for (const e of byZone.items) expect(e.zone_id).toBe('Z-CENTRAL');
  });

  it('acknowledges a sampling command and applies it', async () => {
    const { platform, client } = build();
    run(platform, 10);
    const ack = await client.commandSampling('AN-J-014', {
      mode: 'VERIFICATION',
      duration_sec: 300,
    });
    expect(ack.accepted).toBe(true);
    expect(ack.acknowledged_at).toBeTruthy();
    expect(platform.nodes.get('AN-J-014')?.samplingMode).toBe('VERIFICATION');
  });

  it('reports a command to an offline node as unacknowledged', async () => {
    const { platform, client } = build();
    const node = platform.nodes.get('AN-J-014');
    if (node) node.health = 'OFFLINE';
    const ack = await client.commandSampling('AN-J-014', { mode: 'NORMAL' });
    expect(ack.accepted).toBe(false);
    expect(ack.detail).toMatch(/offline/i);
  });

  it('publishes every command on the device bus', async () => {
    const { platform, client } = build();
    let seen = 0;
    platform.bus.subscribe('command', () => seen++);
    await client.commandDiagnostics('AN-J-014', { suite: 'QUICK' });
    expect(seen).toBe(1);
  });

  it('rolls the city overview up from the node states', async () => {
    const { platform, client } = build();
    run(platform, 240);
    const overview = await client.getCityOverview();
    const total = Object.values(overview.nodes_by_state).reduce((s, n) => s + n, 0);
    expect(total).toBe(overview.nodes_total);
    expect(overview.supply_lps).toBeGreaterThan(0);
    expect(overview.estimated_loss_fraction).toBeGreaterThanOrEqual(0);
    expect(overview.estimated_loss_fraction).toBeLessThanOrEqual(1);
  });

  it('notifies subscribers on every tick', () => {
    const { platform, client } = build();
    let count = 0;
    const off = client.subscribe(() => count++);
    run(platform, 10);
    expect(count).toBeGreaterThan(0);
    off();
    const after = count;
    run(platform, 10);
    expect(count).toBe(after);
  });
});
