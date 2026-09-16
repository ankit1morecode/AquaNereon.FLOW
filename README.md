# AquaNereon.FLOW — Urban Water Intelligence Frontend

The full operator frontend for the AquaNereon.FLOW platform: five screens from
the software dossier (§27), the seven named components, a typed client covering
every REST endpoint in §23 and the MQTT topic design in §24 — and the 3D
hydraulic visualization embedded where it belongs, on the node it describes.

```bash
npm install
npm run dev        # http://localhost:5178
npm test           # 174 tests over the physics, measurement chain and services
npm run probe      # headless walk-through of the three flow scenarios
npm run build
```

It runs with no backend. A platform simulator advances nine nodes in the
browser and serves them through the same `ApiClient` interface the HTTP client
implements, which is what the dossier asks for when it says simulation must use
the production ingestion and query contracts (§16, §30.2).

```bash
# Point it at a real backend instead — this is the whole switch.
VITE_API_BASE_URL=https://backend/api/v1 npm run dev
```

Copy `.env.example` to `.env.local` for basemap keys and the backend URL.

---

## The one idea holding it together

**Every number on every screen is computed by the same physics the 3D view
runs.** Each simulated node drives the real velocity field, the real 16-element
sensor-ring model, the real baseline comparison and the real four-state
machine. A node's signature on City Command and the water in the Node
Diagnostics viewport are two renderings of one computation, not two mock
datasets that happen to agree.

That is why the disturbance you see in the viewport — inlet A surging, inlet B
starving, the vortex core breaking down — is the same disturbance that raised
the event, weighted the evidence, moved the loss estimate and pushed the node
into high-resolution sampling.

```
scenario dataset → junction condition → velocity field → sensor ring
   → flow signature → baseline distance → state machine
      → event + evidence → risk → recommendation → verification
```

---

## Screens

| Screen | What it answers |
| --- | --- |
| **City Command** | Network-wide supply, demand, node states, events, risk. Network schematic at the centre, because every question here is spatial |
| **Zone Intelligence** | Consumption, forecast demand, inferred losses, shortage risk, per zone |
| **Node Diagnostics** | The physical-to-AI chain for one node, laid out as that chain |
| **Events** | Prioritised events beside the full evidence that formed each one |
| **Reports** | History, interventions, forecast backtest, and verification |
| **3D Junction** | The visualization full-screen ([detail below](#the-3d-module)) |

**Node Diagnostics** is the one the dossier is pointed about: it must expose the
physical-to-AI chain rather than being "a generic dashboard full of decorative
rectangles" (§28). So it reads top to bottom as that chain — the water, then
what the ring saw, then how far that is from baseline, then what the state
machine made of it, then the raw traces, then neighbours and control. The 3D
viewport and the circumferential plot beside it are the same computation twice,
not an illustration next to a number.

**Events** never shows a conclusion without its basis. Each event carries the
nine things §16 requires — what changed, where, when, how far from baseline,
how fast, whether it persisted, what the neighbours did, which models agreed,
and how good the data was — and each evidence item shows its weight, so a
conclusion resting on one strong signal looks different from one resting on six
weak ones.

---

## Components

The seven from §27, plus the primitives they share.

| Component | Notes |
| --- | --- |
| `NetworkMap` | Leaflet, with the hydraulic graph drawn over real ground. Pipe flow animates at a rate set by actual throughput, so a starved branch visibly slows |
| `NodeStatus` | State, health, recent deviation, and whether the software has already raised its own sampling |
| `FlowSignatureChart` | Baseline distance against the thresholds it is classified on, so the badge is checkable rather than declarative |
| `CircumferentialProfile` | The 16 channels against baseline — the fingerprint, shown raw rather than reduced to a score (§2) |
| `ForecastChart` | Prediction interval drawn, not optional, plus the backtest error. A bare forecast line invites being read as fact |
| `EventTimeline` | Severity first, recency second: the worst thing happening now, not the newest |
| `EvidencePanel` | The nine questions, answered from the event's own evidence |
| `JunctionPreview` | Bridges a node's telemetry into the 3D module's data seam. Lazily loaded |

**Charts are hand-drawn SVG.** The dossier proposes Plotly or ECharts; both are
excellent and both are around half a megabyte, and neither matches the
instrument styling without a page of theme overrides. What the screens need is
four shapes — a line, a band, a bar row, a sparkline — so they are drawn
directly. That is the point to bring a real charting library in behind the same
component surface if brushing, zooming and export are ever needed.

---

## The network

Twenty-one diagnostic junctions across five zones, fed from three sources, on
a Leaflet map (dossier §18). Pipes are drawn between the junctions they
connect, so the graph the digital twin reasons over is visible on top of the
streets it runs under, and upstream/downstream means something you can point
at.

| Zone | Junctions | Served |
| --- | --- | --- |
| Northgate | 4 | 62,000 |
| Millfield | 4 | 51,000 |
| Central Basin | 5 | 93,000 |
| Dockside | 4 | 58,000 |
| Southbank | 4 | 67,400 |

The map is driven imperatively rather than through React components. Node
states update several times a second across twenty-odd markers and their
pipes; restyling existing Leaflet layers is far cheaper than reconciling a
component tree at that rate, and it stops the map flickering as data arrives.

> **The layout is illustrative.** It is a plausible distribution network drawn
> over real ground, not a survey of anyone's actual water infrastructure. The
> map says so on its face, and it should keep saying so.

### Basemap

Three sources, in order of preference:

1. `VITE_TILE_URL` — any provider, used verbatim.
2. `VITE_CARTO_KEY` — CARTO raster basemaps, which suit a dark instrument UI.
3. Neither — plain OpenStreetMap tiles, darkened in CSS. Keyless, so a fresh
   clone shows a working map with no setup at all.

If the chosen provider starts failing — expired key, revoked domain, blocked
CDN — the layer falls back to OSM rather than leaving a dark rectangle where
the city should be. If even that is unreachable the vectors still draw, and
the map says the basemap is missing instead of looking broken.

Copy `.env.example` to `.env.local` to configure it. **A browser map key is not
a secret:** Vite inlines every `VITE_*` variable into the client bundle, so
whoever loads the page can read it. That is normal for this class of
credential — the protection is a domain restriction in the provider's
dashboard, not concealment. `.env.local` is gitignored so the key stays out of
the repository, which is a different concern and also worth doing.

---

## Services

```
services/
├── client.ts             the ApiClient interface — every endpoint in §23
├── httpClient.ts         the real backend
├── simulatedClient.ts    the in-browser platform, same interface
├── platformSimulator.ts  nine nodes, events, forecasts, risk
├── nodeSimulator.ts      one node, running the real physics
├── mqtt.ts               §24 topics, QoS, retain, and a local device bus
└── ApiProvider.tsx       picks one client; useQuery reads from it
```

`ApiClient` is the seam. `SimulatedApiClient` and `HttpApiClient` implement it
identically, and a test asserts the surfaces match structurally rather than
trusting that someone ran the type checker before shipping.

Two things the live path handles that are easy to skip:

- **A stale feed reports zero flow, not the last good frame.** A frozen frame
  looks exactly like a healthy node reporting a steady condition.
- **The websocket reconnects underneath a source whose identity never changes**,
  so a backend restart does not remount the visualization and discard its
  baseline and history.

### MQTT

The frontend does not speak MQTT — the broker is the device plane and a browser
has no business on it. `services/mqtt.ts` exists so the topic strings, payload
shapes, QoS and retain flags live in one place shared by the edge, the backend
relay and the simulator, rather than being retyped as string literals in three
codebases.

| Topic | QoS | Retain | Why |
| --- | --- | --- | --- |
| `aquanereon/{node_id}/telemetry` | 0 | no | High rate, individually expendable |
| `aquanereon/{node_id}/signature` | 1 | no | Losing one loses a window of analysis |
| `aquanereon/{node_id}/health` | 1 | **yes** | Last-known state is worth keeping |
| `aquanereon/{node_id}/event` | **2** | no | Must not be lost, must not become two alerts |
| `aquanereon/{node_id}/command` | **2** | no | Same, in the other direction |
| `aquanereon/{node_id}/ack` | 1 | no | Correlated to a command that is still open |

---

## Design

One dark instrument palette across the platform. The 3D view has to be dark —
water read as illuminated tracers needs a black ground — so the rest matches it
rather than making an operator's eyes re-adapt on every navigation.

The four state colours are the backbone. They mean exactly one thing each and
are never used decoratively:

| | |
| --- | --- |
| **Stable** `#4fe0a0` | Behaviour matches baseline |
| **Drift** `#ffd166` | Small or developing deviation |
| **Pre-disturbance** `#ff9a4d` | Clear abnormal behaviour forming |
| **Disturbance** `#ff5f7a` | Strong deviation present |

Severity reuses the same ramp, because an event's severity is downstream of the
state that produced it and should not look unrelated. Everything is built from
one `Panel` primitive, so adding a screen does not mean inventing a container.
Monospace wherever numbers are compared column to column.

Two facts stay visible from every screen: the worst node state anywhere on the
network, and whether the data is real or simulated. The second because a
demonstration that does not say it is a demonstration is the easiest way to
lose an audience's trust later.

---

## The 3D module

`src/viz/` is self-contained and unchanged by the platform around it. Two
inlet streams interact inside a transparent chamber, the interaction produces a
swirling flow field, a circumferential ring reads that field around the outlet,
and the pattern it reads is the flow fingerprint.

| On screen | What it represents |
| --- | --- |
| Cyan / amber streaks | Water from inlet A / inlet B |
| Streak **length** | Local speed — distance covered in a fixed shutter time |
| Bright filament | The vortex core line, where it sits and how it precesses |
| Red spindle | Recirculation: the core has broken down and the water is moving backwards |
| Ring of 16 lit pods | Each pod shows its own channel reading |

Four camera presets on keys **1–4**; the **Sensor ring** one is a bore-scope
looking back up the outlet, and it is the only angle from which the
circumferential pattern reads as a *pattern* rather than a brightness gradient.
Scrubbable timeline, 0.25×–2× playback, a 30-second fingerprint waterfall, and
full keyboard control. Press **?** in the view for the legend and key map.

### How the vortex is produced

The two inlet ports sit off-axis in both y and z, point-symmetric about the
outlet axis, each carrying a tangential component. That makes the chamber a
swirl generator. Everything downstream follows from momentum bookkeeping:

| Quantity | Comes from |
| --- | --- |
| Swirl number `S = L / (R · M)` | Angular vs axial momentum flux. Geometric, so it barely moves — correct for a fixed chamber |
| Core displacement | The **transverse** momentum flux the branches fail to cancel. Zero when balanced |
| Momentum lean | The same imbalance tilting the whole bore. The larger effect at the ring |
| Axial core deficit | Rises with swirl and restriction. Above 1.0 a recirculation bubble opens |

So an unbalanced junction does not play a drift animation — it has a sideways
momentum surplus, which puts the core off-centre, which the ring reads as a
mode-1 asymmetry. Continuity holds to ~2% across the outlet, measured by
quadrature in the tests.

> **Scope.** The velocity field is phenomenological, built from named fluid
> mechanics terms. Every term corresponds to a real mechanism and the picture
> responds to an inlet change the way the hardware would, but it does not solve
> Navier-Stokes and must not be presented as if it does.

---

## Tests

`npm test` — 174 tests, no DOM and no WebGL, because the whole measurement
chain and the whole service layer are pure TypeScript.

| File | Covers |
| --- | --- |
| `flowField.test.ts` | Continuity by quadrature, boundedness, wall confinement, solenoidal turbulence, core reversal |
| `fieldParams.test.ts` | Momentum bookkeeping: swirl is geometric, imbalance displaces the core |
| `sensorRing.test.ts` | Even ring when balanced, mode-1 dominance, broadband transition, baseline, hysteresis |
| `scenarios.test.ts` | Each dataset end-to-end; the three separate in order |
| `dataSources.test.ts` | Stale feeds, malformed frames, socket reconnect, recording round trip |
| `simulation.test.ts` | Tracer containment, engine seek, history and temporal features |
| `services.test.ts` | MQTT topics and QoS, device bus retain semantics, demand scale, event evidence completeness, client interchangeability, command acknowledgement |

Several caught real bugs while being written — the axial velocity on the core
never actually reversed, freshly spawned tracers reported no velocity, and the
tracer depth used for size attenuation was measured in clip space rather than
view space.

---

## Layout

```
src/
├── app/AppShell.tsx       navigation and the always-visible status
├── pages/                 CityCommand, ZoneIntelligence, NodeDiagnostics, Events, Reports
├── components/            the seven from §27, plus charts/ and ui/ primitives
├── services/              API clients, platform simulator, MQTT contract, topology
├── types/api.ts           wire types, snake_case, matching §23
├── styles/                tokens, app, viz
└── viz/                   the 3D module — core/ has no Three.js import anywhere
```

**Performance.** The 3D renderer is code-split: the platform shell is 106 kB
gzipped, and the 1 MB renderer chunk downloads only when a 3D view is opened.
Tracer advection runs about 6.5 ms per frame at 18k particles; the budget is
chosen from `hardwareConcurrency` and adjustable live.

**If WebGL fails** — remote desktop, blocklisted driver, or simply too many
live contexts — the module detects it before mounting, catches anything that
throws after, and recovers from a lost context by remounting with a bounded
number of retries before explaining what happened. The failure mode is never a
blank white rectangle.

---

## Props

```tsx
<JunctionFlow3D
  source={...}          // FlowDataSource; omit to replay the bundled scenarios
  particleCount={12000}
  chrome={false}        // hide the module's overlay panels when embedding
  keyboard={false}      // release the window key bindings
  onRecording={(rec) => ...}
/>
```
