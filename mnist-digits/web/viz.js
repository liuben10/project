// Drawing code: the network diagram, the accuracy chart and the activation plot.
(function () {
  "use strict";

  // ---- colours (read from CSS variables so light/dark mode stay in sync) ----
  const VARS = {
    surface: "--surface", ink: "--ink", ink2: "--ink-2", muted: "--muted", border: "--border",
    neutral: "--neutral", pos: "--pos", posMax: "--pos-max", neg: "--neg",
    s1: "--series-1", s2: "--series-2",
  };
  function parseHex(hex) {
    let h = hex.trim().replace("#", "");
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const theme = {
    refresh() {
      const cs = getComputedStyle(document.documentElement);
      for (const [key, v] of Object.entries(VARS)) this[key] = parseHex(cs.getPropertyValue(v));
    },
  };
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const rgba = (c, alpha = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${alpha})`;

  /** v in [-1, 1] -> colour. 0 is neutral grey, positive is blue (stronger = deeper), negative is red. */
  function valueColor(v) {
    if (!(v === v)) return theme.neutral; // NaN
    v = Math.max(-1, Math.min(1, v));
    if (v >= 0) return v < 0.5 ? mix(theme.neutral, theme.pos, v * 2) : mix(theme.pos, theme.posMax, (v - 0.5) * 2);
    return mix(theme.neutral, theme.neg, -v);
  }

  function fmtCount(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + " billion";
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + " million";
    return Math.round(n).toLocaleString();
  }
  const pct = (p, digits = 1) => (p * 100).toFixed(digits) + "%";

  function setupCanvas(canvas, cssHeight) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    canvas.style.height = cssHeight + "px";
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h: cssHeight };
  }

  // ---- shared tooltip ------------------------------------------------------
  const tip = {
    el: null,
    show(html, clientX, clientY) {
      const el = this.el || (this.el = document.getElementById("tooltip"));
      el.innerHTML = html;
      el.hidden = false;
      const pad = 14, wv = window.innerWidth, hv = window.innerHeight;
      let x = clientX + pad, y = clientY + pad;
      if (x + el.offsetWidth > wv - 8) x = clientX - pad - el.offsetWidth;
      if (y + el.offsetHeight > hv - 8) y = clientY - pad - el.offsetHeight;
      el.style.left = Math.max(8, x) + "px";
      el.style.top = Math.max(8, y) + "px";
    },
    hide() { if (this.el) this.el.hidden = true; },
  };

  /** A 28x28 image of signed values as a data URL (blue +, red -), for tooltips. */
  function weightImage(values) {
    let max = 1e-9;
    for (const v of values) max = Math.max(max, Math.abs(v));
    const c = document.createElement("canvas");
    c.width = c.height = 28;
    const ctx = c.getContext("2d"), img = ctx.createImageData(28, 28);
    for (let p = 0; p < 784; p++) {
      const col = valueColor(values[p] / max);
      img.data.set([col[0], col[1], col[2], 255], p * 4);
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL();
  }

  // ---- network diagram -----------------------------------------------------
  class NetworkView {
    constructor(canvas) {
      this.canvas = canvas;
      this.net = null;
      this.snap = null;
      this.info = {};
      this.hover = null;
      new ResizeObserver(() => this.resize()).observe(canvas);
      canvas.addEventListener("mousemove", (e) => this.onMove(e));
      canvas.addEventListener("mouseleave", () => {
        this.hover = null;
        tip.hide();
        this.draw();
      });
    }

    resize() {
      const w = this.canvas.clientWidth;
      if (!w) return;
      const h = Math.round(Math.min(560, Math.max(360, w * 0.48)));
      Object.assign(this, setupCanvas(this.canvas, h));
      this.layout = null;
      this.draw();
    }

    /** Copy the activations net currently holds (call right after net.forward). */
    show(net, info = {}) {
      if (this.net !== net) this.layout = null;
      this.net = net;
      this.snap = { a: net.a.map((a) => Float32Array.from(a)), z: net.z.map((z) => Float32Array.from(z)) };
      this.info = info;
      this.draw();
    }

    /** Show the network with nothing flowing through it. */
    clear(net) {
      if (this.net !== net) this.layout = null;
      this.net = net;
      this.snap = null;
      this.info = {};
      this.draw();
    }

    computeLayout() {
      const { w, h } = this, sizes = this.net.sizes, L = sizes.length - 1;
      const pad = 14, top = 36, bottom = h - 12;
      const outSpace = Math.min(165, Math.max(110, w * 0.17));
      const G = Math.min(bottom - top, w * 0.24);
      const grid = { x: pad, y: top + (bottom - top - G) / 2, size: G, cell: G / 28 };
      const xStart = grid.x + G + Math.max(56, w * 0.1);
      const xEnd = w - pad - outSpace;
      const cols = [];
      for (let l = 1; l <= L; l++) {
        const n = sizes[l];
        const x = xStart + ((xEnd - xStart) * (l - 1)) / Math.max(1, L - 1);
        const spacing = (bottom - top) / n;
        const r = Math.max(2.5, Math.min(l === L ? 13 : 10, spacing * 0.4));
        const ys = Array.from({ length: n }, (_, k) => top + spacing * (k + 0.5));
        cols.push({ x, ys, r, n, spacing });
      }
      this.layout = { grid, cols, xEnd };
    }

    /** Map a layer's raw activations into -1..1 for colouring. */
    normalizer(values) {
      const range = this.net.act.range;
      if (range) return (v) => v / Math.max(Math.abs(range[0]), Math.abs(range[1]));
      let m = 1e-6;
      for (const v of values) m = Math.max(m, Math.abs(v));
      return (v) => v / m; // unbounded (ReLU etc.): scale to the layer's strongest neuron
    }

    draw() {
      if (!this.ctx || !this.net) return;
      if (!this.layout) this.computeLayout();
      const { ctx, w, h } = this, { grid, cols } = this.layout;
      const net = this.net, snap = this.snap, L = net.sizes.length - 1;
      const font = "system-ui, -apple-system, 'Segoe UI', sans-serif";

      ctx.fillStyle = rgba(theme.surface);
      ctx.fillRect(0, 0, w, h);

      // Column titles
      ctx.font = `600 12px ${font}`;
      ctx.fillStyle = rgba(theme.ink2);
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      // Use the longest set of titles that fits between columns (narrow screens get short ones).
      const centers = [grid.x + grid.size / 2, ...cols.map((c) => c.x)];
      const titleSets = [
        ["Input: 784 pixels", ...cols.map((c, j) => (j === L - 1 ? "Output: 10 digits" : `Hidden layer ${j + 1}: ${c.n}`))],
        ["Input", ...cols.map((c, j) => (j === L - 1 ? "Output" : `Hidden ${j + 1}`))],
        ["In", ...cols.map((c, j) => (j === L - 1 ? "Out" : `H${j + 1}`))],
      ];
      const fits = (titles) => titles.every((t, k) => {
        const half = ctx.measureText(t).width / 2;
        if (centers[k] + half > w - 4) return false;
        if (k === 0) return true;
        return ctx.measureText(titles[k - 1]).width / 2 + half + 10 <= centers[k] - centers[k - 1];
      });
      const titles = titleSets.find(fits) || titleSets[titleSets.length - 1];
      titles.forEach((t, k) => ctx.fillText(t, centers[k], 20));

      // Input -> hidden 1: 784 x n connections are too many to draw, so draw a faint fan.
      const c1 = cols[0];
      ctx.strokeStyle = rgba(theme.muted, 0.13);
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      for (let k = 0; k < 7; k++) {
        const y0 = grid.y + (grid.size * (k + 0.5)) / 7;
        for (const y of c1.ys) {
          ctx.moveTo(grid.x + grid.size + 2, y0);
          ctx.lineTo(c1.x - c1.r, y);
        }
      }
      ctx.stroke();

      // Input pixels, coloured on the same scale as neurons.
      const input = snap ? snap.a[0] : null;
      const cell = grid.cell;
      for (let p = 0; p < 784; p++) {
        ctx.fillStyle = rgba(valueColor(input ? input[p] : 0));
        ctx.fillRect(grid.x + (p % 28) * cell, grid.y + ((p / 28) | 0) * cell, cell + 0.5, cell + 0.5);
      }
      if (this.hover && this.hover.layer === 0) {
        const p = this.hover.index;
        ctx.strokeStyle = rgba(theme.ink);
        ctx.lineWidth = 1.5;
        ctx.strokeRect(grid.x + (p % 28) * cell, grid.y + ((p / 28) | 0) * cell, cell, cell);
      }
      ctx.strokeStyle = rgba(theme.border);
      ctx.lineWidth = 1;
      ctx.strokeRect(grid.x - 0.5, grid.y - 0.5, grid.size + 1, grid.size + 1);

      // Hidden -> hidden -> output connections, coloured by the signal each carries
      // (weight x the sending neuron's activation): blue pushes up, red pushes down.
      for (let l = 1; l < L; l++) {
        const src = cols[l - 1], dst = cols[l], W = net.W[l], nIn = src.n;
        if (!snap) {
          ctx.strokeStyle = rgba(theme.muted, 0.08);
          ctx.lineWidth = 0.5;
          ctx.beginPath();
          for (let o = 0; o < dst.n; o++)
            for (let i = 0; i < nIn; i++) {
              ctx.moveTo(src.x + src.r, src.ys[i]);
              ctx.lineTo(dst.x - dst.r, dst.ys[o]);
            }
          ctx.stroke();
          continue;
        }
        const aIn = snap.a[l];
        let max = 1e-9;
        for (let k = 0; k < W.length; k++) max = Math.max(max, Math.abs(W[k] * aIn[k % nIn]));
        const focus = this.hover && (this.hover.layer === l || this.hover.layer === l + 1) ? this.hover : null;
        for (let o = 0; o < dst.n; o++) {
          for (let i = 0; i < nIn; i++) {
            const c = W[o * nIn + i] * aIn[i];
            let t = Math.abs(c) / max;
            if (focus) {
              const related = (focus.layer === l && focus.index === i) || (focus.layer === l + 1 && focus.index === o);
              if (!related) t *= 0.15;
            }
            if (t < 0.04) continue;
            ctx.strokeStyle = rgba(c > 0 ? theme.pos : theme.neg, 0.12 + 0.78 * t);
            ctx.lineWidth = 0.4 + 2.2 * t;
            ctx.beginPath();
            ctx.moveTo(src.x + src.r, src.ys[i]);
            ctx.lineTo(dst.x - dst.r, dst.ys[o]);
            ctx.stroke();
          }
        }
      }

      // Neurons
      cols.forEach((c, j) => {
        const l = j + 1, vals = snap ? snap.a[l] : null;
        const norm = vals ? (l === L ? (v) => v : this.normalizer(vals)) : null;
        for (let k = 0; k < c.n; k++) {
          const hovered = this.hover && this.hover.layer === l && this.hover.index === k;
          ctx.beginPath();
          ctx.arc(c.x, c.ys[k], c.r, 0, 2 * Math.PI);
          ctx.fillStyle = rgba(valueColor(vals ? norm(vals[k]) : 0));
          ctx.fill();
          ctx.lineWidth = hovered ? 2.5 : 1;
          ctx.strokeStyle = rgba(hovered ? theme.ink : theme.border);
          ctx.stroke();
        }
      });

      // Output labels + probability bars
      const out = cols[L - 1], probs = snap ? snap.a[L] : null;
      let pred = -1;
      if (probs) for (let k = 0; k < 10; k++) if (pred < 0 || probs[k] > probs[pred]) pred = k;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      const labelX = out.x + out.r + 10;
      const barX = labelX + 22;
      const barMax = Math.max(16, w - 14 - barX - 46);
      for (let k = 0; k < 10; k++) {
        const y = out.ys[k], p = probs ? probs[k] : 0;
        ctx.font = `${k === pred ? 700 : 500} 13px ${font}`;
        ctx.fillStyle = rgba(k === pred ? theme.ink : theme.ink2);
        ctx.fillText(String(k), labelX, y);
        if (this.info.label === k) {
          // Box the correct answer
          ctx.strokeStyle = rgba(theme.ink);
          ctx.lineWidth = 1.5;
          ctx.strokeRect(labelX - 5, y - 9, 18, 18);
        }
        ctx.fillStyle = rgba(theme.neutral);
        ctx.fillRect(barX, y - 4, barMax, 8);
        ctx.fillStyle = rgba(k === pred ? theme.pos : theme.muted);
        ctx.fillRect(barX, y - 4, barMax * p, 8);
        if (probs) {
          ctx.font = `12px ${font}`;
          ctx.fillStyle = rgba(theme.ink2);
          ctx.fillText(pct(p, p >= 0.995 || p < 0.005 ? 0 : 1), barX + barMax + 6, y);
        }
      }
    }

    hitTest(x, y) {
      const { grid, cols } = this.layout;
      if (x >= grid.x && x < grid.x + grid.size && y >= grid.y && y < grid.y + grid.size) {
        const px = Math.floor((x - grid.x) / grid.cell), py = Math.floor((y - grid.y) / grid.cell);
        return { layer: 0, index: py * 28 + px };
      }
      for (let j = 0; j < cols.length; j++) {
        const c = cols[j];
        if (Math.abs(x - c.x) > Math.max(c.r + 4, 9)) continue;
        const k = Math.round((y - c.ys[0]) / c.spacing);
        if (k >= 0 && k < c.n && Math.abs(y - c.ys[k]) <= Math.max(c.r + 4, c.spacing / 2)) return { layer: j + 1, index: k };
      }
      return null;
    }

    onMove(e) {
      if (!this.layout || !this.net) return;
      const rect = this.canvas.getBoundingClientRect();
      const hit = this.hitTest(e.clientX - rect.left, e.clientY - rect.top);
      const changed = (hit && hit.layer) !== (this.hover && this.hover.layer) || (hit && hit.index) !== (this.hover && this.hover.index);
      this.hover = hit;
      if (changed) this.draw();
      if (hit) tip.show(this.describe(hit), e.clientX, e.clientY);
      else tip.hide();
    }

    /** Tooltip contents for a hovered pixel or neuron. */
    describe({ layer, index }) {
      const net = this.net, snap = this.snap, L = net.sizes.length - 1;
      const f3 = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(3));
      if (layer === 0) {
        const v = snap ? snap.a[0][index] : 0;
        return `<b>Pixel (${index % 28}, ${(index / 28) | 0})</b><br>brightness ${v.toFixed(2)}` +
          `<div class="muted">Each pixel is one input neuron (0 = black, 1 = white).</div>`;
      }
      const nIn = net.sizes[layer - 1];
      const W = net.W[layer - 1];
      const head = layer === L ? `<b>Output neuron for digit ${index}</b>` : `<b>Hidden layer ${layer}, neuron ${index}</b>`;
      let body = "";
      if (snap) {
        const a = snap.a[layer][index], z = snap.z[layer - 1][index];
        body += layer === L
          ? `<br>probability <b>${pct(a)}</b> (score ${f3(z)})`
          : `<br>activation <b>${f3(a)}</b><br>weighted sum in: ${f3(z)}`;
      }
      if (layer === 1) {
        body += `<img alt="" src="${weightImage(W.subarray(index * nIn, (index + 1) * nIn))}">` +
          `<div class="muted">What it responds to: its 784 incoming weights, laid out as an image. ` +
          `Ink on blue pixels excites it; ink on red pixels inhibits it.</div>`;
      } else if (snap) {
        const aIn = snap.a[layer - 1];
        const contrib = Array.from({ length: nIn }, (_, i) => [i, W[index * nIn + i] * aIn[i]])
          .sort((p, q) => Math.abs(q[1]) - Math.abs(p[1])).slice(0, 3);
        body += `<div class="muted spaced">Biggest influences from hidden layer ${layer - 1}:<br>` +
          contrib.map(([i, c]) => `neuron ${i}: ${c >= 0 ? "+" : "−"}${Math.abs(c).toFixed(2)}`).join("<br>") + "</div>";
      }
      return head + body;
    }
  }

  // ---- accuracy chart ------------------------------------------------------
  class AccuracyChart {
    constructor(canvas) {
      this.canvas = canvas;
      this.train = [];
      this.test = [];
      this.hoverX = null;
      new ResizeObserver(() => this.resize()).observe(canvas);
      canvas.addEventListener("mousemove", (e) => {
        const r = canvas.getBoundingClientRect();
        this.hoverX = e.clientX - r.left;
        this.draw();
        this.showTip(e);
      });
      canvas.addEventListener("mouseleave", () => { this.hoverX = null; tip.hide(); this.draw(); });
    }
    resize() {
      if (!this.canvas.clientWidth) return;
      Object.assign(this, setupCanvas(this.canvas, 220));
      this.draw();
    }
    reset() { this.train = []; this.test = []; this.draw(); }
    addTrain(x, y) {
      this.train.push([x, y]);
      if (this.train.length > 1600) this.train = this.train.filter((_, i) => i % 2 === 0);
    }
    addTest(x, y) { this.test.push([x, y]); }
    frame() {
      const left = 44, right = 14, top = 10, bottom = 26;
      const xMax = Math.max(1000, ...this.train.map((p) => p[0]), ...this.test.map((p) => p[0]));
      const pw = this.w - left - right, ph = this.h - top - bottom;
      return { left, top, pw, ph, xMax, sx: (x) => left + (x / xMax) * pw, sy: (y) => top + ph - (y / 100) * ph };
    }
    draw() {
      if (!this.ctx) return;
      const { ctx, w, h } = this, f = this.frame();
      const font = "system-ui, -apple-system, 'Segoe UI', sans-serif";
      ctx.fillStyle = rgba(theme.surface);
      ctx.fillRect(0, 0, w, h);
      ctx.font = `12px ${font}`;
      ctx.lineWidth = 1;
      // gridlines + y labels
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      for (const y of [0, 25, 50, 75, 100]) {
        const py = Math.round(f.sy(y)) + 0.5;
        ctx.strokeStyle = rgba(y === 0 ? theme.muted : theme.border);
        ctx.beginPath(); ctx.moveTo(f.left, py); ctx.lineTo(f.left + f.pw, py); ctx.stroke();
        ctx.fillStyle = rgba(theme.ink2);
        ctx.fillText(y + "%", f.left - 8, py);
      }
      // x labels
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (let k = 0; k <= 4; k++) {
        const x = (f.xMax * k) / 4;
        ctx.fillText(k === 0 ? "0 images" : fmtCount(x), f.sx(x), f.top + f.ph + 8);
      }
      if (!this.train.length) {
        ctx.fillStyle = rgba(theme.muted);
        ctx.textBaseline = "middle";
        ctx.fillText("Start training to see accuracy climb", f.left + f.pw / 2, f.top + f.ph / 2);
        return;
      }
      // training line
      ctx.strokeStyle = rgba(theme.s1);
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.beginPath();
      this.train.forEach(([x, y], i) => (i ? ctx.lineTo(f.sx(x), f.sy(y)) : ctx.moveTo(f.sx(x), f.sy(y))));
      ctx.stroke();
      // test dots with a surface ring so they separate from the line
      for (const [x, y] of this.test) {
        ctx.beginPath();
        ctx.arc(f.sx(x), f.sy(y), 5, 0, 2 * Math.PI);
        ctx.fillStyle = rgba(theme.s2);
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = rgba(theme.surface);
        ctx.stroke();
      }
      // hover crosshair
      if (this.hoverX != null && this.hoverX >= f.left && this.hoverX <= f.left + f.pw) {
        ctx.strokeStyle = rgba(theme.muted);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(this.hoverX) + 0.5, f.top);
        ctx.lineTo(Math.round(this.hoverX) + 0.5, f.top + f.ph);
        ctx.stroke();
      }
    }
    showTip(e) {
      if (!this.train.length) return tip.hide();
      const f = this.frame(), x = ((this.hoverX - f.left) / f.pw) * f.xMax;
      if (x < 0 || x > f.xMax) return tip.hide();
      const nearest = (arr) => arr.reduce((best, p) => (!best || Math.abs(p[0] - x) < Math.abs(best[0] - x) ? p : best), null);
      const tr = nearest(this.train), te = nearest(this.test);
      let html = `<b>After ${fmtCount(tr[0])} images</b><br>recent training accuracy ${tr[1].toFixed(1)}%`;
      if (te && Math.abs(f.sx(te[0]) - this.hoverX) < 24) html += `<br>test accuracy ${te[1].toFixed(1)}% (at ${fmtCount(te[0])})`;
      tip.show(html, e.clientX, e.clientY);
    }
  }

  // ---- activation function plot -------------------------------------------
  function drawActivationPlot(canvas, act) {
    if (!canvas.clientWidth) return;
    const { ctx, w, h } = setupCanvas(canvas, Math.min(260, Math.max(200, canvas.clientWidth * 0.6)));
    const font = "system-ui, -apple-system, 'Segoe UI', sans-serif";
    const xr = [-4, 4], yr = [-1.5, 3];
    const left = 30, right = 10, top = 10, bottom = 22;
    const sx = (x) => left + ((x - xr[0]) / (xr[1] - xr[0])) * (w - left - right);
    const sy = (y) => top + (1 - (y - yr[0]) / (yr[1] - yr[0])) * (h - top - bottom);
    ctx.fillStyle = rgba(theme.surface);
    ctx.fillRect(0, 0, w, h);
    ctx.font = `11px ${font}`;
    ctx.fillStyle = rgba(theme.ink2);
    ctx.lineWidth = 1;
    // grid
    for (let y = -1; y <= 3; y++) {
      ctx.strokeStyle = rgba(y === 0 ? theme.muted : theme.border);
      ctx.beginPath(); ctx.moveTo(left, Math.round(sy(y)) + 0.5); ctx.lineTo(w - right, Math.round(sy(y)) + 0.5); ctx.stroke();
      ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillText(String(y), left - 6, sy(y));
    }
    ctx.strokeStyle = rgba(theme.muted);
    ctx.beginPath(); ctx.moveTo(Math.round(sx(0)) + 0.5, top); ctx.lineTo(Math.round(sx(0)) + 0.5, h - bottom); ctx.stroke();
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (let x = -4; x <= 4; x += 2) ctx.fillText(String(x), sx(x), h - bottom + 6);

    const curve = (fn, color, dashed) => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(left, top, w - left - right, h - top - bottom);
      ctx.clip();
      ctx.strokeStyle = rgba(color);
      ctx.lineWidth = 2;
      ctx.setLineDash(dashed ? [6, 4] : []);
      ctx.beginPath();
      for (let k = 0; k <= 200; k++) {
        const x = xr[0] + ((xr[1] - xr[0]) * k) / 200;
        const y = fn(x);
        k ? ctx.lineTo(sx(x), sy(y)) : ctx.moveTo(sx(x), sy(y));
      }
      ctx.stroke();
      ctx.restore();
    };
    curve((x) => act.df(x, act.f(x)), theme.s2, true);
    curve(act.f, theme.s1, false);
  }

  window.Viz = { theme, valueColor, rgba, setupCanvas, fmtCount, pct, NetworkView, AccuracyChart, drawActivationPlot, tip };
})();
