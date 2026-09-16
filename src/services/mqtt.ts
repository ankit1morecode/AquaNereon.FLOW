import type {
  CommandAck,
  ConfigCommand,
  DiagnosticsCommand,
  FlowSignature,
  NodeHealth,
  NodeId,
  RawWindowCommand,
  SamplingCommand,
  TelemetryFrame,
  WaterEvent,
} from '../types';

/**
 * MQTT topic design, per the software dossier §24.
 *
 * The frontend does not speak MQTT directly — the broker is the device plane,
 * and a browser has no business on it. This module exists so the topic strings
 * and payload shapes live in one place shared by the edge, the backend relay
 * and anything here that mirrors device traffic, rather than being retyped as
 * string literals in three codebases.
 *
 *   aquanereon/{node_id}/telemetry
 *   aquanereon/{node_id}/signature
 *   aquanereon/{node_id}/health
 *   aquanereon/{node_id}/event
 *   aquanereon/{node_id}/command
 *   aquanereon/{node_id}/ack
 */

export const MQTT_ROOT = 'aquanereon';

export type DeviceChannel =
  | 'telemetry'
  | 'signature'
  | 'health'
  | 'event'
  | 'command'
  | 'ack';

/** Build the topic for one node and channel. */
export function topicFor(nodeId: NodeId, channel: DeviceChannel): string {
  return `${MQTT_ROOT}/${nodeId}/${channel}`;
}

/** Wildcard subscription across every node on one channel. */
export function topicWildcard(channel: DeviceChannel): string {
  return `${MQTT_ROOT}/+/${channel}`;
}

/** Parse a topic back into its parts, or null if it is not ours. */
export function parseTopic(
  topic: string,
): { nodeId: NodeId; channel: DeviceChannel } | null {
  const parts = topic.split('/');
  if (parts.length !== 3 || parts[0] !== MQTT_ROOT) return null;
  const channel = parts[2] as DeviceChannel;
  if (
    channel !== 'telemetry' &&
    channel !== 'signature' &&
    channel !== 'health' &&
    channel !== 'event' &&
    channel !== 'command' &&
    channel !== 'ack'
  ) {
    return null;
  }
  return { nodeId: parts[1], channel };
}

/** Payload carried on each channel. Device -> backend except command. */
export interface ChannelPayloads {
  telemetry: TelemetryFrame;
  signature: FlowSignature;
  health: NodeHealth;
  event: WaterEvent;
  command: DeviceCommand;
  ack: CommandAck;
}

/** Backend -> device, on `aquanereon/{node_id}/command`. */
export type DeviceCommand =
  | { command_id: string; kind: 'sampling'; body: SamplingCommand }
  | { command_id: string; kind: 'raw-window'; body: RawWindowCommand }
  | { command_id: string; kind: 'diagnostics'; body: DiagnosticsCommand }
  | { command_id: string; kind: 'config'; body: ConfigCommand };

/** Quality of service per channel, so nothing important rides QoS 0 by accident. */
export const CHANNEL_QOS: Record<DeviceChannel, 0 | 1 | 2> = {
  // High rate, individually expendable: the next frame is along shortly.
  telemetry: 0,
  // Derived and comparatively rare; losing one loses a window of analysis.
  signature: 1,
  health: 1,
  // Must not be lost, must not be duplicated into two alerts.
  event: 2,
  command: 2,
  ack: 1,
};

/** Retain flags: last-known state is worth keeping, a data stream is not. */
export const CHANNEL_RETAIN: Record<DeviceChannel, boolean> = {
  telemetry: false,
  signature: false,
  health: true,
  event: false,
  command: false,
  ack: false,
};

/**
 * A transport that carries device traffic. Implemented over a real broker on
 * the backend, and over the in-browser simulator here, so a page that mirrors
 * live device messages does not need to know which.
 */
export interface DeviceBus {
  publish<C extends DeviceChannel>(
    nodeId: NodeId,
    channel: C,
    payload: ChannelPayloads[C],
  ): void;
  subscribe<C extends DeviceChannel>(
    channel: C,
    listener: (nodeId: NodeId, payload: ChannelPayloads[C]) => void,
  ): () => void;
}

/** In-process bus. Same semantics, no broker. */
export class LocalDeviceBus implements DeviceBus {
  private readonly listeners = new Map<DeviceChannel, Set<(n: NodeId, p: never) => void>>();
  /** Last retained payload per topic, replayed to new subscribers. */
  private readonly retained = new Map<string, unknown>();

  publish<C extends DeviceChannel>(
    nodeId: NodeId,
    channel: C,
    payload: ChannelPayloads[C],
  ): void {
    if (CHANNEL_RETAIN[channel]) {
      this.retained.set(topicFor(nodeId, channel), payload);
    }
    const set = this.listeners.get(channel);
    if (!set) return;
    for (const listener of set) {
      (listener as (n: NodeId, p: ChannelPayloads[C]) => void)(nodeId, payload);
    }
  }

  subscribe<C extends DeviceChannel>(
    channel: C,
    listener: (nodeId: NodeId, payload: ChannelPayloads[C]) => void,
  ): () => void {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(listener as (n: NodeId, p: never) => void);

    // Replay retained messages, the way a broker would on subscribe.
    if (CHANNEL_RETAIN[channel]) {
      for (const [topic, payload] of this.retained) {
        const parsed = parseTopic(topic);
        if (parsed?.channel === channel) {
          listener(parsed.nodeId, payload as ChannelPayloads[C]);
        }
      }
    }

    return () => {
      set?.delete(listener as (n: NodeId, p: never) => void);
    };
  }
}
