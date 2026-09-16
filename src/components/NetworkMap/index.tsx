import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { FlowState, NetworkGraph, NodeId, NodeSummary, WaterEvent } from '../../types';
import { MAP_VIEW, zoneHull } from '../../services/topology';
import { propagationPath, suspectRegion } from '../../services/propagation';
import { STATE_LABEL } from '../ui';

/**
 * The hydraulic network on a map.
 *
 * Geographic rather than schematic, because the questions asked of this view
 * are ultimately about ground: which part of the city, what is upstream of it,
 * and where do we send someone. Pipes are drawn between the junctions they
 * connect, so the graph structure the digital twin reasons over (dossier §12)
 * is visible on top of the streets it runs under.
 *
 * Driven imperatively rather than through React. Node states update several
 * times a second and there are twenty-odd markers plus their pipes; restyling
 * existing Leaflet layers is far cheaper than reconciling a component tree at
 * that rate, and it keeps the map from flickering as data arrives.
 *
 * Scope note: the layout is illustrative. It is a plausible distribution
 * network drawn over real ground, not a survey of anyone's actual water
 * infrastructure, and the map says so.
 */

const STATE_COLOR: Record<FlowState, string> = {
  STABLE: '#4fe0a0',
  DRIFT: '#ffd166',
  PRE_DISTURBANCE: '#ff9a4d',
  DISTURBANCE: '#ff5f7a',
};

/**
 * Basemap.
 *
 * Three sources, in order of preference:
 *
 *   1. VITE_TILE_URL — any provider you want, used verbatim.
 *   2. VITE_CARTO_KEY — CARTO's raster basemaps, which look right for a dark
 *      instrument UI without needing a filter.
 *   3. Neither — plain OpenStreetMap tiles, darkened in CSS. Keyless, so the
 *      map works for anyone who clones this with no setup at all.
 *
 * The key is read from the environment rather than written here because this
 * repository is public. It is worth being clear that this does not make it
 * secret: Vite inlines every VITE_* variable into the client bundle, so a
 * browser map key is always readable by whoever loads the page. That is normal
 * for this class of credential — the protection is a domain restriction in the
 * provider's dashboard, not concealment.
 *
 * If the chosen provider starts failing — an expired key, a revoked domain,
 * a network with the CDN blocked — the layer falls back to OSM rather than
 * leaving a dark rectangle where the city should be.
 */
const CUSTOM_TILE_URL = import.meta.env.VITE_TILE_URL as string | undefined;
const CARTO_KEY = import.meta.env.VITE_CARTO_KEY as string | undefined;
const CARTO_STYLE = (import.meta.env.VITE_CARTO_STYLE as string | undefined) ?? 'dark_all';

interface TileSource {
  url: string;
  attribution: string;
  /** Light tiles that need inverting to sit under a dark interface. */
  darken: boolean;
}

const OSM_SOURCE: TileSource = {
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  darken: true,
};

function primarySource(): TileSource {
  if (CUSTOM_TILE_URL) {
    return {
      url: CUSTOM_TILE_URL,
      attribution: (import.meta.env.VITE_TILE_ATTRIBUTION as string | undefined) ?? '',
      darken: false,
    };
  }
  if (CARTO_KEY) {
    return {
      url: `https://basemaps.cartocdn.com/rastertiles/${CARTO_STYLE}/{z}/{x}/{y}.png?key=${CARTO_KEY}`,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      // CARTO's dark styles are already dark; inverting them would undo that.
      darken: CARTO_STYLE.startsWith('voyager') || CARTO_STYLE.startsWith('positron'),
    };
  }
  return OSM_SOURCE;
}

const PRIMARY_SOURCE = primarySource();

export interface NetworkMapProps {
  network: NetworkGraph;
  nodes: NodeSummary[];
  events?: WaterEvent[];
  selected?: NodeId | null;
  onSelect?: (nodeId: NodeId) => void;
  /** Dim everything outside this zone and fit the view to it. */
  focusZone?: string | null;
  /**
   * Pixels, or any CSS length. Pass "100%" to fill a panel that is itself
   * sized by the grid — a map is a better use of spare height than a gap.
   */
  height?: number | string;
  /**
   * Trace one event on the map: the chain of disturbed feeders it came down,
   * and the stretch of pipe a suspected loss would be in. An event that says
   * "PROPAGATED" without showing the path is asking to be taken on trust.
   */
  focusEvent?: WaterEvent | null;
  /** Centre on the focused event rather than fitting the whole zone. */
  followEvent?: boolean;
}

interface NodeLayers {
  dot: L.CircleMarker;
  halo: L.CircleMarker;
  alert: L.CircleMarker;
}

export function NetworkMap({
  network,
  nodes,
  events = [],
  selected = null,
  onSelect,
  focusZone = null,
  height = 420,
  focusEvent = null,
  followEvent = false,
}: NetworkMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const nodeLayersRef = useRef(new Map<NodeId, NodeLayers>());
  const pipeLayersRef = useRef(new Map<string, { casing: L.Polyline; flow: L.Polyline }>());
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  /** The view we want when nobody has panned or zoomed away from it. */
  const highlightRef = useRef<L.Layer[]>([]);
  const fitBoundsRef = useRef<L.LatLngBounds | null>(null);
  const userMovedRef = useRef(false);
  const programmaticRef = useRef(false);

  const [tilesFailed, setTilesFailed] = useState(false);
  const [darken, setDarken] = useState(PRIMARY_SOURCE.darken);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.node_id, n])), [nodes]);
  const openByNode = useMemo(() => {
    const map = new Map<NodeId, number>();
    for (const e of events) {
      if (e.status === 'CLOSED') continue;
      map.set(e.node_id, (map.get(e.node_id) ?? 0) + 1);
    }
    return map;
  }, [events]);

  /* ---- build the map once ---- */
  useEffect(() => {
    const container = containerRef.current;
    if (!container || mapRef.current) return;

    const map = L.map(container, {
      center: MAP_VIEW.center,
      zoom: MAP_VIEW.zoom,
      minZoom: MAP_VIEW.minZoom,
      maxZoom: MAP_VIEW.maxZoom,
      zoomControl: true,
      attributionControl: true,
      // The map lives inside a scrolling page; grabbing the wheel as someone
      // scrolls past it is the single most irritating thing an embedded map
      // can do. Ctrl+wheel still zooms, and so do the buttons.
      scrollWheelZoom: false,
    });
    mapRef.current = map;

    let usingFallback = false;

    const addTiles = (source: TileSource) => {
      const layer = L.tileLayer(source.url, {
        attribution: source.attribution,
        maxZoom: MAP_VIEW.maxZoom,
      });

      let errors = 0;
      layer.on('tileerror', () => {
        errors += 1;
        if (errors <= 3) return;
        if (!usingFallback && source !== OSM_SOURCE) {
          // The chosen provider is not answering. Swap to the keyless one
          // rather than leaving the city blank.
          usingFallback = true;
          layer.remove();
          setDarken(OSM_SOURCE.darken);
          addTiles(OSM_SOURCE);
          return;
        }
        // Even the fallback is unreachable. Vectors still draw, so this
        // degrades to a dark plan rather than an empty panel — say which.
        setTilesFailed(true);
      });
      layer.on('tileload', () => setTilesFailed(false));
      layer.addTo(map);
    };

    addTiles(PRIMARY_SOURCE);

    // Distinguish our own fitBounds from someone dragging the map, so a
    // container resize does not yank the view back from wherever they went.
    map.on('movestart', () => {
      if (!programmaticRef.current) userMovedRef.current = true;
    });

    return () => {
      map.remove();
      mapRef.current = null;
      nodeLayersRef.current.clear();
      pipeLayersRef.current.clear();
    };
  }, []);

  /* ---- zones, pipes and markers ---- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const layers: L.Layer[] = [];
    const vertexById = new Map(network.vertices.map((v) => [v.id, v]));

    // --- zone areas ---
    for (const zone of network.zones) {
      const members = network.vertices.filter((v) => v.zone_id === zone.zone_id);
      const hull = zoneHull(members.map((m) => m.location));
      if (hull.length < 3) continue;

      const polygon = L.polygon(hull, {
        className: 'nm-zone',
        interactive: false,
      }).addTo(map);
      polygon.bindTooltip(zone.name, {
        permanent: true,
        direction: 'center',
        className: 'nm-zone-label',
      });
      layers.push(polygon);
    }

    // --- pipes ---
    for (const edge of network.edges) {
      const from = vertexById.get(edge.from);
      const to = vertexById.get(edge.to);
      if (!from || !to) continue;

      const path: [number, number][] = [
        [from.location.lat, from.location.lng],
        [to.location.lat, to.location.lng],
      ];

      const casing = L.polyline(path, {
        className: 'nm-pipe',
        weight: 2 + (edge.diameter_mm / 260) * 4,
        interactive: false,
      }).addTo(map);

      const flow = L.polyline(path, {
        className: 'nm-flow',
        weight: 2,
        interactive: false,
      }).addTo(map);

      flow.bindTooltip(
        `${edge.pipe_id}<br>DN${edge.diameter_mm} · ${(edge.length_m / 1000).toFixed(2)} km`,
        { className: 'nm-tip', sticky: true },
      );

      pipeLayersRef.current.set(edge.pipe_id, { casing, flow });
      layers.push(casing, flow);
    }

    // --- sources ---
    for (const vertex of network.vertices) {
      if (vertex.kind === 'JUNCTION') continue;
      const marker = L.marker([vertex.location.lat, vertex.location.lng], {
        icon: L.divIcon({
          className: 'nm-source-icon',
          html: `<span class="nm-source-mark"></span><span class="nm-source-name">${vertex.location.label}</span>`,
          iconSize: [14, 14],
          iconAnchor: [7, 7],
        }),
        interactive: false,
        keyboard: false,
      }).addTo(map);
      layers.push(marker);
    }

    // --- junctions ---
    for (const vertex of network.vertices) {
      if (vertex.kind !== 'JUNCTION') continue;
      const pos: [number, number] = [vertex.location.lat, vertex.location.lng];

      // Drawn back to front: the alert pulse, then the selection halo, then
      // the node itself, so the node is always the thing you click.
      const alert = L.circleMarker(pos, {
        radius: 13,
        className: 'nm-alert',
        interactive: false,
      }).addTo(map);
      alert.setStyle({ opacity: 0, fillOpacity: 0 });

      const halo = L.circleMarker(pos, {
        radius: 12,
        className: 'nm-halo',
        interactive: false,
      }).addTo(map);
      halo.setStyle({ opacity: 0, fillOpacity: 0 });

      const dot = L.circleMarker(pos, {
        radius: 7,
        className: 'nm-dot',
        weight: 2,
      }).addTo(map);

      dot.on('click', () => onSelectRef.current?.(vertex.id));
      dot.bindTooltip(vertex.id.replace('AN-J-', 'J'), {
        permanent: true,
        direction: 'top',
        offset: [0, -9],
        className: 'nm-id',
      });

      nodeLayersRef.current.set(vertex.id, { dot, halo, alert });
      layers.push(alert, halo, dot);
    }

    return () => {
      for (const layer of layers) layer.remove();
      nodeLayersRef.current.clear();
      pipeLayersRef.current.clear();
    };
  }, [network]);

  /* ---- live styling: state colour, alerts, selection, focus ---- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    for (const [nodeId, { dot, halo, alert }] of nodeLayersRef.current) {
      const summary = byId.get(nodeId);
      const vertex = network.vertices.find((v) => v.id === nodeId);
      const dimmed = focusZone !== null && vertex?.zone_id !== focusZone;
      const colour = summary ? STATE_COLOR[summary.state] : '#56697a';
      const offline = summary?.health === 'OFFLINE';

      dot.setStyle({
        color: offline ? '#ff5f7a' : colour,
        fillColor: offline ? '#0a141d' : colour,
        fillOpacity: dimmed ? 0.25 : 1,
        opacity: dimmed ? 0.3 : 1,
        dashArray: offline ? '3 3' : undefined,
      });

      const isSelected = selected === nodeId;
      halo.setStyle({
        color: '#d6e9f5',
        opacity: isSelected && !dimmed ? 0.85 : 0,
        fillOpacity: 0,
      });

      const alerts = openByNode.get(nodeId) ?? 0;
      alert.setStyle({
        color: colour,
        opacity: alerts > 0 && !dimmed ? 0.6 : 0,
        fillOpacity: 0,
      });

      // The pulse is a CSS animation on the rendered path; toggling the class
      // is cheaper and smoother than animating the radius from JS.
      const el = (alert as unknown as { _path?: SVGElement })._path;
      if (el) el.classList.toggle('pulsing', alerts > 0 && !dimmed);

      if (summary) {
        dot.bindPopup(
          `<strong>${vertex?.location.label ?? nodeId}</strong>` +
            `<span class="nm-pop-id">${nodeId}</span>` +
            `<span class="nm-pop-row">${STATE_LABEL[summary.state]} · ${summary.flow_lps.toFixed(1)} L/s</span>` +
            `<span class="nm-pop-row">anomaly ${summary.anomaly_score.toFixed(2)} · ${summary.sampling_mode.toLowerCase()}</span>` +
            (vertex?.location.address
              ? `<span class="nm-pop-addr">${vertex.location.address}</span>`
              : ''),
          { className: 'nm-popup', closeButton: false },
        );
      }
    }

    // Pipe animation speed follows the throughput of the node it feeds, so a
    // starved branch visibly slows instead of merely being labelled.
    for (const edge of network.edges) {
      const layer = pipeLayersRef.current.get(edge.pipe_id);
      if (!layer) continue;
      const downstream = byId.get(edge.to);
      const load = downstream ? downstream.flow_lps / Math.max(edge.nominal_flow_lps, 1) : 0.6;
      const period = Math.max(0.7, 4.5 - load * 3.2);

      const toVertex = network.vertices.find((v) => v.id === edge.to);
      const dimmed = focusZone !== null && toVertex?.zone_id !== focusZone;

      const el = (layer.flow as unknown as { _path?: SVGElement })._path;
      if (el) el.style.animationDuration = `${period}s`;
      layer.flow.setStyle({ opacity: dimmed ? 0.12 : 0.75 });
      layer.casing.setStyle({ opacity: dimmed ? 0.12 : 1 });
    }
  }, [byId, openByNode, selected, focusZone, network]);

  /* ---- trace the focused event: propagation path and suspect region ---- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    for (const layer of highlightRef.current) layer.remove();
    highlightRef.current = [];
    if (!focusEvent) return;

    const vertexById = new Map(network.vertices.map((v) => [v.id, v]));
    const added: L.Layer[] = [];

    // --- the run a suspected loss would be in ---
    // Drawn first so the propagation path sits on top of it where they meet.
    if (focusEvent.suspected_origin) {
      const region = suspectRegion(network, focusEvent.node_id);
      for (const pipeId of region.pipes) {
        const edge = network.edges.find((e) => e.pipe_id === pipeId);
        const from = edge && vertexById.get(edge.from);
        const to = edge && vertexById.get(edge.to);
        if (!from || !to) continue;
        const band = L.polyline(
          [
            [from.location.lat, from.location.lng],
            [to.location.lat, to.location.lng],
          ],
          { className: 'nm-suspect', weight: 11, interactive: false },
        ).addTo(map);
        added.push(band);
      }
    }

    // --- the chain of disturbed feeders it came down ---
    const trace = propagationPath(network, nodes, focusEvent.node_id);
    for (const pipeId of trace.pipes) {
      const edge = network.edges.find((e) => e.pipe_id === pipeId);
      const from = edge && vertexById.get(edge.from);
      const to = edge && vertexById.get(edge.to);
      if (!from || !to) continue;
      const line = L.polyline(
        [
          [from.location.lat, from.location.lng],
          [to.location.lat, to.location.lng],
        ],
        { className: 'nm-propagation', weight: 4, interactive: false },
      ).addTo(map);
      added.push(line);
    }

    // --- the origin of the chain, where there is one ---
    if (!trace.local) {
      const origin = vertexById.get(trace.path[0]);
      if (origin) {
        const marker = L.circleMarker([origin.location.lat, origin.location.lng], {
          radius: 15,
          className: 'nm-origin',
          interactive: false,
        }).addTo(map);
        marker.bindTooltip('origin', {
          permanent: true,
          direction: 'bottom',
          offset: [0, 10],
          className: 'nm-origin-label',
        });
        added.push(marker);
      }
    }

    highlightRef.current = added;
    return () => {
      for (const layer of added) layer.remove();
    };
  }, [focusEvent, network, nodes]);

  /* ---- fit the view to the zone in focus ---- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Following an event means framing the whole path it came down, not just
    // the node it surfaced at — the origin is the part worth seeing.
    const ids =
      followEvent && focusEvent
        ? new Set(propagationPath(network, nodes, focusEvent.node_id).path)
        : null;

    const members = network.vertices.filter((v) =>
      ids ? ids.has(v.id) : focusZone === null || v.zone_id === focusZone,
    );
    if (members.length === 0) return;

    const bounds = L.latLngBounds(members.map((m) => [m.location.lat, m.location.lng]));
    fitBoundsRef.current = bounds;
    userMovedRef.current = false;

    // The container may not have had its final size when the map was created,
    // and fitting against a zero-height box silently produces the wrong view.
    map.invalidateSize({ animate: false });
    programmaticRef.current = true;
    map.fitBounds(bounds, {
      padding: [48, 48],
      maxZoom: ids ? 14 : focusZone ? 14 : 13,
      animate: false,
    });
    programmaticRef.current = false;
  }, [focusZone, network, followEvent, focusEvent, nodes]);

  /* ---- Leaflet needs telling when its container resizes ---- */
  useEffect(() => {
    const map = mapRef.current;
    const container = containerRef.current;
    if (!map || !container) return;

    const observer = new ResizeObserver(() => {
      map.invalidateSize({ animate: false });
      // Re-apply the intended view, unless the operator has moved away from it.
      const bounds = fitBoundsRef.current;
      if (!bounds || userMovedRef.current) return;
      programmaticRef.current = true;
      map.fitBounds(bounds, {
        padding: [48, 48],
        maxZoom: focusZone ? 14 : 13,
        animate: false,
      });
      programmaticRef.current = false;
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [focusZone]);

  return (
    <div className="network-map" style={{ height }}>
      <div
        ref={containerRef}
        className={darken ? 'nm-canvas nm-darken-tiles' : 'nm-canvas'}
      />

      {tilesFailed && (
        <div className="nm-tile-note">
          Basemap unavailable — showing the network without it.
        </div>
      )}

      <ul className="nm-legend">
        {(['STABLE', 'DRIFT', 'PRE_DISTURBANCE', 'DISTURBANCE'] as FlowState[]).map((s) => (
          <li key={s}>
            <i style={{ background: STATE_COLOR[s] }} />
            {STATE_LABEL[s]}
          </li>
        ))}
      </ul>

      <p className="nm-disclaimer">Illustrative network layout, not survey data.</p>
    </div>
  );
}
