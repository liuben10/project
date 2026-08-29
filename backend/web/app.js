const SVG_NS = "http://www.w3.org/2000/svg";

const container = document.getElementById("components");
const template = document.getElementById("component-template");
const statusEl = document.getElementById("conn-status");
const edgesEl = document.getElementById("edges");
const topologyEl = document.querySelector(".topology");

const cards = new Map(); // component id -> DOM node
const edges = new Map(); // "source destination" -> edge

const CELL_WIDTH = 220;
const GRID_PADDING = 24;
const ROW_GAP = 24;
const BARYCENTER_PASSES = 4;

// Cached layout, keyed by a signature of the current topology (node set +
// edge set) - recomputed only when that structure actually changes, so
// cards don't jitter around on every metric update.
let layoutSignature = "";
let nodeLayout = new Map(); // component id -> {layer, order}

function topologySignature() {
  return [...cards.keys()].sort().join(",") + "|" + [...edges.keys()].sort().join(",");
}

// Layered ("Sugiyama-style") auto-layout, the same family of algorithm
// Graphviz's `dot` and dagre use: nodes are assigned to layers by
// dependency depth (callers above callees, via longest path from any node
// with no incoming edge), then ordered within each layer with the
// barycenter heuristic - repeatedly moving each node toward the average
// position of its neighbors in the adjacent layer - to reduce edge
// crossings between layers.
function computeLayeredLayout(nodeIds, edgeList) {
  const outAdj = new Map(nodeIds.map((id) => [id, []]));
  const inAdj = new Map(nodeIds.map((id) => [id, []]));
  const inDegree = new Map(nodeIds.map((id) => [id, 0]));
  for (const e of edgeList) {
    if (!outAdj.has(e.source) || !inAdj.has(e.destination)) continue;
    outAdj.get(e.source).push(e.destination);
    inAdj.get(e.destination).push(e.source);
    inDegree.set(e.destination, inDegree.get(e.destination) + 1);
  }

  // Layer = longest path length from any root, via Kahn's algorithm but
  // tracking max distance instead of just visit order. A cycle's nodes
  // never reach in-degree 0 and simply stay at their initial layer (0) -
  // degrades gracefully instead of looping forever.
  const layer = new Map(nodeIds.map((id) => [id, 0]));
  const remaining = new Map(inDegree);
  let frontier = nodeIds.filter((id) => remaining.get(id) === 0);
  while (frontier.length > 0) {
    const next = [];
    for (const id of frontier) {
      for (const dest of outAdj.get(id)) {
        layer.set(dest, Math.max(layer.get(dest), layer.get(id) + 1));
        remaining.set(dest, remaining.get(dest) - 1);
        if (remaining.get(dest) === 0) next.push(dest);
      }
    }
    frontier = next;
  }

  const layerCount = nodeIds.length === 0 ? 0 : Math.max(...nodeIds.map((id) => layer.get(id))) + 1;
  const layers = Array.from({ length: layerCount }, () => []);
  for (const id of [...nodeIds].sort()) layers[layer.get(id)].push(id); // deterministic seed order

  const positionOf = () => {
    const pos = new Map();
    layers.forEach((layerNodes) => layerNodes.forEach((id, i) => pos.set(id, i)));
    return pos;
  };
  const barycenter = (id, neighbors, pos) =>
    neighbors.length === 0 ? pos.get(id) : neighbors.reduce((sum, n) => sum + pos.get(n), 0) / neighbors.length;

  for (let pass = 0; pass < BARYCENTER_PASSES; pass++) {
    const downward = pass % 2 === 0;
    const order = downward ? layers.map((_, i) => i) : layers.map((_, i) => i).reverse();
    for (const li of order) {
      if ((downward && li === 0) || (!downward && li === layers.length - 1)) continue;
      const pos = positionOf();
      const neighborsOf = downward ? inAdj : outAdj;
      const resorted = layers[li]
        .map((id) => ({ id, bc: barycenter(id, neighborsOf.get(id), pos) }))
        .sort((a, b) => a.bc - b.bc)
        .map(({ id }) => id);
      layers[li] = resorted;
    }
  }

  const result = new Map();
  layers.forEach((layerNodes, li) => layerNodes.forEach((id, order) => result.set(id, { layer: li, order })));
  return result;
}

// Row *height* is measured from actual rendered card heights, not guessed -
// metric counts (and therefore card height) vary per component and can
// change over time as new metrics start reporting, so a fixed cell height
// can't guarantee cards never overlap. This re-stacks every layer's Y
// position from the tallest card actually in it, every time content changes.
function relayout() {
  const signature = topologySignature();
  if (signature !== layoutSignature) {
    layoutSignature = signature;
    nodeLayout = computeLayeredLayout([...cards.keys()], [...edges.values()]);
  }

  const layers = new Map(); // layer number -> [{card, order}]
  for (const [id, card] of cards) {
    const { layer, order } = nodeLayout.get(id) ?? { layer: 0, order: 0 };
    if (!layers.has(layer)) layers.set(layer, []);
    layers.get(layer).push({ card, order });
  }

  let y = GRID_PADDING;
  let maxRight = 0;
  for (const layer of [...layers.keys()].sort((a, b) => a - b)) {
    let rowHeight = 0;
    for (const { card, order } of layers.get(layer).sort((a, b) => a.order - b.order)) {
      const x = GRID_PADDING + order * CELL_WIDTH;
      card.style.left = `${x}px`;
      card.style.top = `${y}px`;
      rowHeight = Math.max(rowHeight, card.offsetHeight);
      maxRight = Math.max(maxRight, x + card.offsetWidth);
    }
    y += rowHeight + ROW_GAP;
  }

  container.style.width = `${maxRight + GRID_PADDING}px`;
  container.style.height = `${y}px`;
  renderEdges();
}

function setStatus(state) {
  statusEl.textContent = state;
  statusEl.className = `status status--${state}`;
}

function formatMetric(name, point) {
  const { value, unit } = point;
  // unit "1" is UCUM for "dimensionless" - it's used both for 0..1 ratios
  // (*.utilization) and for plain counts (e.g. active request count), so the
  // metric name decides which one it is, not the unit alone.
  if (unit === "1" && name.endsWith(".utilization")) return `${(value * 100).toFixed(1)}%`;
  if (unit === "1") return `${value.toFixed(0)}`;
  if (unit === "By") return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (unit === "By/s") return `${(value / (1024 * 1024)).toFixed(2)} MB/s`;
  if (unit === "cores") return `${value.toFixed(2)} cores`;
  if (unit === "1/s") return `${value.toFixed(1)}/s`;
  return `${value}`;
}

function metricLabel(name) {
  return name.replace(/^container\./, "").replace(/[._]/g, " ");
}

// edge.lastSeen is last_seen_unix_nano. Date only needs millisecond
// resolution, so converting ns -> ms first keeps this well within
// Number.MAX_SAFE_INTEGER (unlike displaying the raw nanosecond value).
// The Date getters below (as opposed to getUTC*) read local time, so this
// renders in the browser's system timezone automatically.
function formatTimestamp(lastSeenNano) {
  const date = new Date(lastSeenNano / 1e6);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function renderComponent(component) {
  let card = cards.get(component.id);
  if (!card) {
    card = template.content.firstElementChild.cloneNode(true);
    card.style.position = "absolute";
    cards.set(component.id, card);
    container.appendChild(card);
  }

  card.dataset.type = component.type || "unknown";
  card.querySelector(".name").textContent = component.name || component.id;
  card.querySelector(".type").textContent = component.type || "unknown";

  const metricsEl = card.querySelector(".metrics");
  metricsEl.innerHTML = "";
  const entries = Object.entries(component.metrics || {}).sort(([a], [b]) => a.localeCompare(b));
  for (const [name, point] of entries) {
    const dt = document.createElement("dt");
    dt.textContent = metricLabel(name);
    const dd = document.createElement("dd");
    dd.textContent = formatMetric(name, point);
    metricsEl.appendChild(dt);
    metricsEl.appendChild(dd);
  }

  // Content just changed, which can change this card's height - re-stack
  // every row's position from actual measured heights so nothing overlaps.
  relayout();
}

function edgeKey(source, destination) {
  return `${source} ${destination}`;
}

function applyEdge(edge) {
  edges.set(edgeKey(edge.source, edge.destination), edge);
  relayout(); // a new edge can change the dependency structure, not just the drawing
}

// Every distinct (source, destination) pair gets its own line, labeled with
// that pair's own latest last-message time - the backend already collapses
// repeated reports for the same pair down to one row keyed by (source,
// destination) with the newest last_seen, so one edge per pair is exactly
// one line per key here.
function renderEdges() {
  edgesEl.innerHTML = "";
  const topoRect = topologyEl.getBoundingClientRect();

  for (const edge of edges.values()) {
    if (!cards.has(edge.source) || !cards.has(edge.destination)) continue; // both ends must be rendered

    const a = cards.get(edge.source).getBoundingClientRect();
    const b = cards.get(edge.destination).getBoundingClientRect();

    const x1 = a.left + a.width / 2 - topoRect.left;
    const y1 = a.top + a.height / 2 - topoRect.top;
    const x2 = b.left + b.width / 2 - topoRect.left;
    const y2 = b.top + b.height / 2 - topoRect.top;

    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", x1);
    line.setAttribute("y1", y1);
    line.setAttribute("x2", x2);
    line.setAttribute("y2", y2);
    edgesEl.appendChild(line);

    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("x", (x1 + x2) / 2);
    label.setAttribute("y", (y1 + y2) / 2);
    label.setAttribute("text-anchor", "middle");
    label.textContent = formatTimestamp(edge.lastSeen);
    edgesEl.appendChild(label);
  }
}

window.addEventListener("resize", renderEdges);
setInterval(renderEdges, 5000); // keeps edge line positions live as layout shifts

function connect() {
  setStatus("connecting");
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => setStatus("connected");
  ws.onclose = () => {
    setStatus("disconnected");
    setTimeout(connect, 2000);
  };
  ws.onerror = () => ws.close();

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "snapshot") {
      for (const component of msg.components || []) renderComponent(component);
      for (const edge of msg.edges || []) edges.set(edgeKey(edge.source, edge.destination), edge);
      relayout();
    } else if (msg.type === "update") {
      renderComponent(msg.component);
    } else if (msg.type === "edge_update") {
      applyEdge(msg.edge);
    }
  };
}

connect();
