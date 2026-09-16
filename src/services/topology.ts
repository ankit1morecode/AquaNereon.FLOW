import type { NodeId, NodeLocation, Zone } from '../types';

/**
 * The instrumented network.
 *
 * Real coordinates, because the network view is a real map and an inspection
 * has to be dispatched somewhere. The layout is **illustrative**: a plausible
 * distribution network drawn over real ground, not a survey of anyone's actual
 * water infrastructure. The map says so on its face, and it should keep saying
 * so if this is ever shown to someone who might assume otherwise.
 *
 * Twenty-one diagnostic junctions across five zones, fed from three sources.
 * Flow runs outward from the sources, so upstream and downstream on the map
 * mean what they mean in the hydraulic graph.
 *
 * Separated from the simulator because this is data and that is behaviour:
 * replacing it with a GIS export should not mean touching the event logic.
 */

export interface NodeSeed {
  id: NodeId;
  zone: string;
  lat: number;
  lng: number;
  label: string;
  address: string;
  /** Design throughput of the junction, L/s. */
  nominal: number;
  /** Which bundled flow scenario this node lives on. */
  scenario: 'NORMAL' | 'DRIFT' | 'DISTURBANCE';
  /** Multiplier on branch flows, giving each node its own duty. */
  scale: number;
  /** Seconds added to the scenario clock, so nodes are not in lockstep. */
  phase: number;
  upstream: NodeId[];
}

export interface SourceSeed {
  id: string;
  zone: string;
  lat: number;
  lng: number;
  label: string;
  address: string;
  kind: 'RESERVOIR' | 'PUMP';
}

/**
 * Served population per zone, sized so mean demand is comparable to what the
 * junctions actually deliver. Inventing a larger city on top of the same
 * network would make every supply-versus-demand figure meaningless.
 */
export const ZONE_SEEDS: Zone[] = [
  { zone_id: 'Z-NORTH', name: 'Northgate', population: 62000, node_ids: [] },
  { zone_id: 'Z-WEST', name: 'Millfield', population: 51000, node_ids: [] },
  { zone_id: 'Z-CENTRAL', name: 'Central Basin', population: 93000, node_ids: [] },
  { zone_id: 'Z-EAST', name: 'Dockside', population: 58000, node_ids: [] },
  { zone_id: 'Z-SOUTH', name: 'Southbank', population: 67400, node_ids: [] },
];

export const NODE_SEEDS: NodeSeed[] = [
  /* ---- Northgate: fed from the reservoir, runs south into the basin ---- */
  { id: 'AN-J-002', zone: 'Z-NORTH', lat: 55.0085, lng: -1.632, label: 'Northgate inlet', address: 'Great North Road', nominal: 46, scenario: 'NORMAL', scale: 1.22, phase: 3, upstream: ['RES-1'] },
  { id: 'AN-J-005', zone: 'Z-NORTH', lat: 55.0021, lng: -1.6185, label: 'Mill Road cross', address: 'Mill Road at Claremont', nominal: 38, scenario: 'NORMAL', scale: 1.05, phase: 11, upstream: ['AN-J-002'] },
  { id: 'AN-J-008', zone: 'Z-NORTH', lat: 54.9962, lng: -1.6272, label: 'Kingsway tie', address: 'Kingsway South', nominal: 30, scenario: 'DRIFT', scale: 0.92, phase: 6, upstream: ['AN-J-005'] },
  { id: 'AN-J-010', zone: 'Z-NORTH', lat: 55.0044, lng: -1.6042, label: 'Brunton feeder', address: 'Brunton Lane', nominal: 26, scenario: 'NORMAL', scale: 0.81, phase: 34, upstream: ['AN-J-005'] },

  /* ---- Millfield: the western arm off the same reservoir ---- */
  { id: 'AN-J-031', zone: 'Z-WEST', lat: 54.9902, lng: -1.6712, label: 'Millfield inlet', address: 'Millfield Road', nominal: 40, scenario: 'NORMAL', scale: 1.16, phase: 19, upstream: ['RES-1'] },
  { id: 'AN-J-034', zone: 'Z-WEST', lat: 54.9836, lng: -1.6588, label: 'Denton cross', address: 'Denton Bank', nominal: 32, scenario: 'NORMAL', scale: 0.99, phase: 27, upstream: ['AN-J-031'] },
  { id: 'AN-J-037', zone: 'Z-WEST', lat: 54.9744, lng: -1.647, label: 'Elswick tie', address: 'Elswick Road', nominal: 27, scenario: 'NORMAL', scale: 0.86, phase: 41, upstream: ['AN-J-034'] },
  { id: 'AN-J-040', zone: 'Z-WEST', lat: 54.9799, lng: -1.6801, label: 'Scotswood branch', address: 'Scotswood Road', nominal: 24, scenario: 'DRIFT', scale: 0.78, phase: 13, upstream: ['AN-J-031'] },

  /* ---- Central Basin: two feeds in, three branches out ---- */
  { id: 'AN-J-011', zone: 'Z-CENTRAL', lat: 54.9848, lng: -1.6175, label: 'Basin north feed', address: 'Barrack Road', nominal: 44, scenario: 'NORMAL', scale: 1.14, phase: 17, upstream: ['AN-J-005', 'AN-J-034'] },
  { id: 'AN-J-014', zone: 'Z-CENTRAL', lat: 54.9781, lng: -1.6105, label: 'Exchange junction', address: 'Grainger Street', nominal: 36, scenario: 'DISTURBANCE', scale: 1.0, phase: 0, upstream: ['AN-J-011'] },
  { id: 'AN-J-017', zone: 'Z-CENTRAL', lat: 54.9738, lng: -1.6008, label: 'Foundry branch', address: 'City Road', nominal: 29, scenario: 'NORMAL', scale: 0.88, phase: 23, upstream: ['AN-J-014'] },
  { id: 'AN-J-019', zone: 'Z-CENTRAL', lat: 54.9702, lng: -1.6062, label: 'Quayside tie', address: 'The Close', nominal: 27, scenario: 'NORMAL', scale: 0.84, phase: 47, upstream: ['AN-J-014'] },
  { id: 'AN-J-020', zone: 'Z-CENTRAL', lat: 54.9795, lng: -1.6215, label: 'Grainger cross', address: 'Westgate Road', nominal: 25, scenario: 'NORMAL', scale: 0.8, phase: 31, upstream: ['AN-J-011'] },

  /* ---- Dockside: a second source ties in here, so it is not a dead end ---- */
  { id: 'AN-J-043', zone: 'Z-EAST', lat: 54.9769, lng: -1.5762, label: 'Byker inlet', address: 'Shields Road', nominal: 33, scenario: 'NORMAL', scale: 1.02, phase: 8, upstream: ['AN-J-017', 'RES-3'] },
  { id: 'AN-J-046', zone: 'Z-EAST', lat: 54.9738, lng: -1.5849, label: 'Ouseburn cross', address: 'Ouseburn Road', nominal: 28, scenario: 'NORMAL', scale: 0.9, phase: 37, upstream: ['AN-J-043'] },
  { id: 'AN-J-049', zone: 'Z-EAST', lat: 54.9723, lng: -1.5462, label: 'Walker tie', address: 'Walker Road', nominal: 24, scenario: 'DRIFT', scale: 0.82, phase: 22, upstream: ['AN-J-043'] },
  { id: 'AN-J-052', zone: 'Z-EAST', lat: 54.9691, lng: -1.5601, label: 'Dockside terminus', address: 'St Peters Basin', nominal: 21, scenario: 'NORMAL', scale: 0.74, phase: 44, upstream: ['AN-J-046', 'AN-J-049'] },

  /* ---- Southbank: across the river, with its own pumping station ---- */
  { id: 'AN-J-021', zone: 'Z-SOUTH', lat: 54.9631, lng: -1.6023, label: 'Southbank tie', address: 'Gateshead High Street', nominal: 38, scenario: 'NORMAL', scale: 1.08, phase: 9, upstream: ['AN-J-019', 'RES-2'] },
  { id: 'AN-J-024', zone: 'Z-SOUTH', lat: 54.9558, lng: -1.5947, label: 'Felling cross', address: 'Sunderland Road', nominal: 30, scenario: 'DRIFT', scale: 0.94, phase: 29, upstream: ['AN-J-021'] },
  { id: 'AN-J-027', zone: 'Z-SOUTH', lat: 54.9512, lng: -1.5788, label: 'Harbour terminus', address: 'Heworth Way', nominal: 24, scenario: 'NORMAL', scale: 0.76, phase: 14, upstream: ['AN-J-024'] },
  { id: 'AN-J-029', zone: 'Z-SOUTH', lat: 54.9575, lng: -1.6152, label: 'Saltwell branch', address: 'Saltwell Road', nominal: 26, scenario: 'NORMAL', scale: 0.83, phase: 51, upstream: ['AN-J-021'] },
];

export const SOURCE_SEEDS: SourceSeed[] = [
  { id: 'RES-1', zone: 'Z-NORTH', lat: 55.0182, lng: -1.6528, label: 'Highfield reservoir', address: 'Highfield', kind: 'RESERVOIR' },
  { id: 'RES-2', zone: 'Z-SOUTH', lat: 54.9482, lng: -1.6208, label: 'Southbank pumping', address: 'Lobley Hill', kind: 'PUMP' },
  { id: 'RES-3', zone: 'Z-EAST', lat: 54.9812, lng: -1.5388, label: 'Eastgate intake', address: 'Wallsend Road', kind: 'RESERVOIR' },
];

/** Where the map opens, and how far out it will let you zoom. */
export const MAP_VIEW = {
  center: [54.9805, -1.6085] as [number, number],
  zoom: 12,
  minZoom: 10,
  maxZoom: 17,
};

/** Great-circle distance in metres, so pipe lengths mean something. */
export function haversineMetres(a: NodeLocation, b: NodeLocation): number {
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Convex hull of a set of points, expanded outward from their centroid.
 *
 * Used to draw a zone as an area rather than as a scatter of pins. Andrew's
 * monotone chain; the expansion is what stops the hull cutting through the
 * markers that define it.
 */
export function zoneHull(
  points: { lat: number; lng: number }[],
  padding = 1.28,
): [number, number][] {
  if (points.length === 0) return [];
  if (points.length < 3) {
    // Too few to enclose: return a small box so the zone is still visible.
    const d = 0.004;
    return points.flatMap((p) => [
      [p.lat - d, p.lng - d],
      [p.lat - d, p.lng + d],
      [p.lat + d, p.lng + d],
      [p.lat + d, p.lng - d],
    ]) as [number, number][];
  }

  const pts = [...points].sort((a, b) => a.lng - b.lng || a.lat - b.lat);
  const cross = (
    o: { lat: number; lng: number },
    a: { lat: number; lng: number },
    b: { lat: number; lng: number },
  ) => (a.lng - o.lng) * (b.lat - o.lat) - (a.lat - o.lat) * (b.lng - o.lng);

  const lower: typeof pts = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: typeof pts = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  const cLat = hull.reduce((s, p) => s + p.lat, 0) / hull.length;
  const cLng = hull.reduce((s, p) => s + p.lng, 0) / hull.length;

  return hull.map(
    (p) =>
      [cLat + (p.lat - cLat) * padding, cLng + (p.lng - cLng) * padding] as [number, number],
  );
}
