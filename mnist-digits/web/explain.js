// Interactive parts of the "Build the network" explainer: a single-neuron
// playground, the layer-shape summary, and the loss-function plot.
(function () {
  "use strict";
  const { ACTIVATIONS } = window.NN;
  const { theme, valueColor, rgba, setupCanvas } = window.Viz;
  const $ = (id) => document.getElementById(id);
  const SVG = "http://www.w3.org/2000/svg";

  // The perceptron's original hard threshold, only used in the playground.
  const LAB_ACTIVATIONS = {
    step: { label: "Step (1958 perceptron)", f: (z) => (z > 0 ? 1 : 0), range: [0, 1] },
    ...ACTIVATIONS,
  };

  // ---- one-neuron playground -----------------------------------------------
  const lab = {
    x: [0.9, 0.3, 0.6],
    w: [1.2, -0.8, 0.5],
    b: -0.4,
  };

  function el(tag, attrs, parent) {
    const node = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (parent) parent.appendChild(node);
    return node;
  }

  let svgParts = null;
  function buildNeuronSvg() {
    const svg = $("neuron-svg");
    svg.textContent = "";
    const inY = [40, 100, 160], cx = 215, cy = 100;
    const parts = { syn: [], inputs: [], wLabels: [], xLabels: [] };
    inY.forEach((y, i) => {
      parts.syn.push(el("line", { x1: 46, y1: y, x2: cx - 30, y2: cy, class: "syn" }, svg));
    });
    inY.forEach((y, i) => {
      parts.inputs.push(el("circle", { cx: 30, cy: y, r: 16, class: "node" }, svg));
      const t = el("text", { x: 30, y: y + 4, class: "node-text", "text-anchor": "middle" }, svg);
      parts.xLabels.push(t);
      // Label each connection partway along its line: above it for the top two, below for the last.
      const t45 = 0.42, lx = 46 + (cx - 30 - 46) * t45, ly = y + (cy - y) * t45;
      const wl = el("text", { x: lx, y: ly + (i === 2 ? 17 : -8), class: "w-text", "text-anchor": "middle" }, svg);
      parts.wLabels.push(wl);
    });
    el("line", { x1: cx + 30, y1: cy, x2: 300, y2: cy, class: "axon" }, svg);
    parts.body = el("circle", { cx, cy, r: 30, class: "node body" }, svg);
    parts.sum = el("text", { x: cx, y: cy - 4, class: "node-text", "text-anchor": "middle" }, svg);
    parts.fz = el("text", { x: cx, y: cy + 13, class: "node-sub", "text-anchor": "middle" }, svg);
    parts.out = el("circle", { cx: 322, cy, r: 20, class: "node" }, svg);
    parts.outText = el("text", { x: 322, y: cy + 4, class: "node-text", "text-anchor": "middle" }, svg);
    parts.bias = el("text", { x: cx, y: cy + 50, class: "w-text", "text-anchor": "middle" }, svg);
    el("text", { x: 30, y: 192, class: "caption", "text-anchor": "middle" }, svg).textContent = "inputs x";
    el("text", { x: 322, y: 140, class: "caption", "text-anchor": "middle" }, svg).textContent = "output a";
    svgParts = parts;
  }

  function slider(container, label, id, min, max, step, value, onInput) {
    const wrap = document.createElement("label");
    wrap.className = "lab-slider";
    wrap.htmlFor = id;
    const name = document.createElement("span");
    name.innerHTML = label;
    const input = Object.assign(document.createElement("input"), { type: "range", id, min, max, step, value });
    const out = document.createElement("output");
    out.textContent = (+value).toFixed(1);
    input.addEventListener("input", () => { out.textContent = (+input.value).toFixed(1); onInput(+input.value); });
    wrap.append(name, input, out);
    container.appendChild(wrap);
  }

  function buildLab() {
    const box = $("lab-sliders");
    box.textContent = "";
    for (let i = 0; i < 3; i++) {
      slider(box, `input x<sub>${i + 1}</sub>`, `lab-x${i}`, 0, 1, 0.1, lab.x[i], (v) => { lab.x[i] = v; updateLab(); });
      slider(box, `weight w<sub>${i + 1}</sub>`, `lab-w${i}`, -2, 2, 0.1, lab.w[i], (v) => { lab.w[i] = v; updateLab(); });
    }
    slider(box, "bias b", "lab-b", -2, 2, 0.1, lab.b, (v) => { lab.b = v; updateLab(); });
    const sel = $("lab-act");
    for (const [key, act] of Object.entries(LAB_ACTIVATIONS)) sel.add(new Option(act.label, key));
    sel.value = "step";
    sel.addEventListener("change", updateLab);
    buildNeuronSvg();
    updateLab();
  }

  const fmt = (v) => (Math.abs(v) < 0.005 ? "0.00" : v.toFixed(2).replace("-", "−"));
  const signed = (v) => (v < 0 ? `(${fmt(v)})` : fmt(v));

  function updateLab() {
    if (!svgParts) return;
    const act = LAB_ACTIVATIONS[$("lab-act").value];
    const z = lab.w.reduce((s, w, i) => s + w * lab.x[i], lab.b);
    const a = act.f(z);
    const p = svgParts;
    lab.x.forEach((x, i) => {
      p.inputs[i].setAttribute("fill", rgba(valueColor(x)));
      p.xLabels[i].textContent = x.toFixed(1);
      p.xLabels[i].setAttribute("class", "node-text" + (x > 0.55 ? " on-dark" : ""));
      const w = lab.w[i], signal = w * x;
      p.syn[i].setAttribute("class", "syn " + (w >= 0 ? "pos" : "neg"));
      p.syn[i].setAttribute("stroke-width", (0.75 + 2.5 * Math.min(1, Math.abs(signal) / 2)).toFixed(2));
      p.syn[i].setAttribute("stroke-opacity", (0.25 + 0.75 * Math.min(1, Math.abs(signal) / 1.5)).toFixed(2));
      p.wLabels[i].textContent = `w${i + 1} = ${w.toFixed(1).replace("-", "−")}`;
    });
    const scale = act.range ? Math.max(Math.abs(act.range[0]), Math.abs(act.range[1])) : 3;
    const shade = Math.max(-1, Math.min(1, a / scale));
    p.body.setAttribute("fill", rgba(valueColor(Math.max(-1, Math.min(1, z / 3)))));
    p.sum.textContent = `z = ${fmt(z)}`;
    p.fz.textContent = "f(z)";
    p.out.setAttribute("fill", rgba(valueColor(shade)));
    p.outText.textContent = fmt(a);
    p.outText.setAttribute("class", "node-text" + (Math.abs(shade) > 0.55 ? " on-dark" : ""));
    p.bias.textContent = `bias b = ${lab.b.toFixed(1).replace("-", "−")}`;
    const terms = lab.w.map((w, i) => `${signed(w)}×${lab.x[i].toFixed(1)}`).join(" + ");
    $("lab-readout").innerHTML =
      `z = ${terms} + ${signed(lab.b)} = <strong>${fmt(z)}</strong><br>` +
      `a = ${act.label.split(" (")[0].toLowerCase()}(${fmt(z)}) = <strong>${fmt(a)}</strong>`;
  }

  // ---- layer shapes for the chosen architecture ----------------------------
  function updateLayerShapes() {
    const hidden = $("arch").value.split(",").map(Number);
    const sizes = [784, ...hidden, 10];
    const names = ["input", ...hidden.map((_, i) => `hidden layer ${i + 1}`), "output"];
    let total = 0;
    const rows = [];
    for (let l = 1; l < sizes.length; l++) {
      const n = sizes[l] * sizes[l - 1];
      total += n + sizes[l];
      rows.push(`<li><var>W<sub>${l}</sub></var> is ${sizes[l]}×${sizes[l - 1]} = ${n.toLocaleString()} weights ` +
        `(${names[l - 1]} → ${names[l]}), plus ${sizes[l]} biases</li>`);
    }
    $("layer-shapes").innerHTML =
      `The network you're about to build (${sizes.join(" → ")}) is ${sizes.length - 1} matrix multiplications:` +
      `<ul class="shapes">${rows.join("")}</ul>` +
      `That's <strong>${total.toLocaleString()}</strong> numbers to learn. The 784 inputs are the image's pixels, ` +
      `read row by row into one long vector.`;
  }

  // ---- loss plot ------------------------------------------------------------
  function drawLoss() {
    const canvas = $("loss-canvas");
    if (!canvas.clientWidth) return;
    const p = +$("loss-p").value / 100;
    const loss = -Math.log(p);
    $("loss-readout").innerHTML =
      `p<sub>correct</sub> = ${p.toFixed(2)} &nbsp;→&nbsp; loss = −ln(${p.toFixed(2)}) = <strong>${loss.toFixed(2)}</strong>` +
      `<br><span class="muted small">${p >= 0.95 ? "Confident and right: almost no penalty." :
        p >= 0.5 ? "Right, but unsure: a small penalty." :
        p >= 0.1 ? "Mostly wrong: a real penalty." : "Confidently wrong: a huge penalty."}</span>`;

    const { ctx, w, h } = setupCanvas(canvas, 200);
    const font = "system-ui, -apple-system, 'Segoe UI', sans-serif";
    const left = 34, right = 12, top = 10, bottom = 30, yMax = 5;
    const sx = (v) => left + v * (w - left - right);
    const sy = (v) => top + (1 - v / yMax) * (h - top - bottom);
    ctx.fillStyle = rgba(theme.surface);
    ctx.fillRect(0, 0, w, h);
    ctx.font = `11px ${font}`;
    ctx.lineWidth = 1;
    for (let y = 0; y <= yMax; y++) {
      ctx.strokeStyle = rgba(y === 0 ? theme.muted : theme.border);
      ctx.beginPath(); ctx.moveTo(left, Math.round(sy(y)) + 0.5); ctx.lineTo(w - right, Math.round(sy(y)) + 0.5); ctx.stroke();
      ctx.fillStyle = rgba(theme.ink2); ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillText(String(y), left - 6, sy(y));
    }
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (const v of [0, 0.25, 0.5, 0.75, 1]) ctx.fillText(v.toString(), sx(v), h - bottom + 6);
    ctx.fillText("probability given to the correct digit", (left + w - right) / 2, h - 13);

    ctx.save();
    ctx.beginPath(); ctx.rect(left, top, w - left - right, h - top - bottom); ctx.clip();
    ctx.strokeStyle = rgba(theme.s1); ctx.lineWidth = 2; ctx.beginPath();
    for (let k = 1; k <= 200; k++) {
      const v = k / 200, y = -Math.log(v);
      k === 1 ? ctx.moveTo(sx(v), sy(y)) : ctx.lineTo(sx(v), sy(y));
    }
    ctx.stroke();
    ctx.restore();
    // marker for the slider's value, with a surface ring
    const my = sy(Math.min(yMax, loss));
    ctx.strokeStyle = rgba(theme.muted); ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(sx(p), sy(0)); ctx.lineTo(sx(p), my); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(sx(p), my, 6, 0, 2 * Math.PI);
    ctx.fillStyle = rgba(theme.s1); ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = rgba(theme.surface); ctx.stroke();
  }

  function redraw() {
    updateLab();
    drawLoss();
  }

  function init() {
    buildLab();
    updateLayerShapes();
    $("arch").addEventListener("change", updateLayerShapes);
    $("loss-p").addEventListener("input", drawLoss);
    new ResizeObserver(drawLoss).observe($("loss-canvas"));
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      theme.refresh();
      redraw();
    });
  }

  theme.refresh();
  init();
})();
