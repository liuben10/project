const container = document.getElementById("components");
const template = document.getElementById("component-template");
const statusEl = document.getElementById("conn-status");

const cards = new Map(); // component id -> DOM node

function setStatus(state) {
  statusEl.textContent = state;
  statusEl.className = `status status--${state}`;
}

function formatMetric(name, point) {
  const { value, unit } = point;
  if (unit === "1") return `${(value * 100).toFixed(1)}%`;
  if (unit === "By") return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (unit === "cores") return `${value.toFixed(2)} cores`;
  return `${value}`;
}

function metricLabel(name) {
  return name.replace(/^container\./, "").replace(/[._]/g, " ");
}

function renderComponent(component) {
  let card = cards.get(component.id);
  if (!card) {
    card = template.content.firstElementChild.cloneNode(true);
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
}

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
    } else if (msg.type === "update") {
      renderComponent(msg.component);
    }
  };
}

connect();
