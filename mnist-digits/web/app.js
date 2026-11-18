// Page logic: loading data, the training loop, the image slider and the sketch pad.
(function () {
  "use strict";
  const { MLP, ACTIVATIONS } = window.NN;
  const { theme, fmtCount, pct, NetworkView, AccuracyChart, drawActivationPlot } = window.Viz;
  const $ = (id) => document.getElementById(id);

  const SPEEDS = [
    [1, "1 image / second"], [3, "3 images / second"], [10, "10 images / second"],
    [30, "30 images / second"], [100, "100 images / second"], [1000, "1,000 images / second"],
    [Infinity, "As fast as possible"],
  ];
  const RECENT = 500; // window for "recent accuracy"

  const state = {
    data: null,
    net: null,
    seed: 1,
    cursor: 0,           // index of the next training image
    epoch: 1,
    running: false,
    lr: 0.1,
    owed: 0,             // fractional images owed at slow speeds
    lastTick: 0,
    recent: new Uint8Array(RECENT), recentCount: 0, recentPos: 0,
    testAcc: null, lastEvalSeen: -1, evalPending: false,
    lastChartSeen: 0,
    last: null,          // result of the most recent training step
    lastSketchUpdate: 0,
    diverged: false,
    padHasInk: false,
  };

  let trainView, drawView, chart;

  // ---- data ----------------------------------------------------------------
  async function loadData() {
    const md = window.MNIST_DATA;
    if (!md) throw new Error("Couldn't find web/mnist-data.js. Generate it with: python export_web_data.py");
    if (typeof DecompressionStream === "undefined")
      throw new Error("This browser can't unpack the data (it lacks DecompressionStream). Try a current Chrome, Edge, Firefox or Safari.");
    const raw = atob(md.gzipBase64);
    const bin = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bin[i] = raw.charCodeAt(i);
    const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream("gzip"));
    const buf = new Uint8Array(await new Response(stream).arrayBuffer());
    const dv = new DataView(buf.buffer);
    const nTrain = dv.getUint32(0, true), nTest = dv.getUint32(4, true);
    let off = 8;
    const take = (n) => buf.subarray(off, (off += n));
    return { nTrain, nTest, trainX: take(nTrain * 784), trainY: take(nTrain), testX: take(nTest * 784), testY: take(nTest) };
  }

  // Separate buffers so training, testing and drawing never overwrite each other's input.
  const trainBuf = new Float32Array(784), testBuf = new Float32Array(784);
  function pixels(X, i, out) {
    const base = i * 784;
    for (let p = 0; p < 784; p++) out[p] = X[base + p] / 255;
    return out;
  }

  // ---- network setup -------------------------------------------------------
  const LR_MIN_LOG = -4, LR_MAX_LOG = 0; // learning-rate slider spans 0.0001 .. 1 (log scale)
  const fmtLr = (lr) => (lr >= 0.01 ? lr.toFixed(lr >= 0.1 ? 2 : 3) : lr.toPrecision(2));
  function setLr(lr) {
    state.lr = lr;
    $("lr").value = Math.round(((Math.log10(lr) - LR_MIN_LOG) / (LR_MAX_LOG - LR_MIN_LOG)) * 1000);
    $("lr-out").textContent = fmtLr(lr);
  }

  function buildNetwork({ keepLr = false } = {}) {
    pause({ evaluate: false });
    const actName = $("activation").value;
    const hidden = $("arch").value.split(",").map(Number);
    state.net = new MLP([784, ...hidden, 10], actName, state.seed);
    if (!keepLr) setLr(ACTIVATIONS[actName].lr);
    state.cursor = 0;
    state.epoch = 1;
    state.recent.fill(0);
    state.recentCount = state.recentPos = 0;
    state.testAcc = null;
    state.lastEvalSeen = -1;
    state.evalPending = false;
    state.lastChartSeen = 0;
    state.last = null;
    setDiverged(false);
    $("btn-train").textContent = "Start training";
    chart.reset();
    const n = state.net.numParams();
    $("param-count").textContent = `This network has ${n.toLocaleString()} weights and biases to learn.`;
    $("callout-params").textContent = n.toLocaleString();
    $("st-updates-sub").textContent = `each image nudges all ${n.toLocaleString()}`;
    showTrainingImage(0);
    classifySketch();
    updateStats();
  }

  function describeActivation() {
    const act = ACTIVATIONS[$("activation").value];
    $("act-formula").textContent = act.formula;
    $("act-about").textContent = act.about;
    drawActivationPlot($("act-canvas"), act);
    $("lr-note").textContent =
      `${act.label} trains best with a learning rate of ${fmtLr(act.lr)}, so picking it also sets ` +
      `step 2's learning rate to that. To compare activations on equal terms, set the same rate there.`;
    const canGoNegative = act.f(-1) < 0;
    $("net-legend").innerHTML =
      `<span><i class="ramp pos"></i>neuron firing: weak → strong</span>` +
      (canGoNegative ? `<span><i class="ramp neg"></i>negative output</span>` : "") +
      `<span><i class="line-swatch s1"></i><i class="line-swatch neg"></i>connection pushes next neuron up / down (thicker = stronger signal)</span>` +
      `<span><b class="boxed">7</b>&nbsp;correct answer</span>` +
      (act.range ? "" : `<span>${act.label} has no upper limit, so each layer is shaded relative to its most active neuron.</span>`);
  }

  // ---- training --------------------------------------------------------------
  function recentAccuracy() {
    if (!state.recentCount) return null;
    let s = 0;
    for (let k = 0; k < state.recentCount; k++) s += state.recent[k];
    return s / state.recentCount;
  }

  function trainOne() {
    const { data, net } = state;
    const i = state.cursor, label = data.trainY[i];
    const res = net.trainSample(pixels(data.trainX, i, trainBuf), label, state.lr);
    if (!Number.isFinite(res.loss)) {
      setDiverged(true);
      pause({ evaluate: false });
      return null;
    }
    state.recent[state.recentPos] = res.correct ? 1 : 0;
    state.recentPos = (state.recentPos + 1) % RECENT;
    state.recentCount = Math.min(RECENT, state.recentCount + 1);
    state.last = { i, label, ...res };
    if (++state.cursor >= data.nTrain) {
      state.cursor = 0;
      state.epoch++;
      state.evalPending = true; // run after drawing, so the diagram shows this training image
    }
    const every = net.samplesSeen < 2000 ? 20 : 100;
    if (net.samplesSeen - state.lastChartSeen >= every) {
      chart.addTrain(net.samplesSeen, 100 * recentAccuracy());
      state.lastChartSeen = net.samplesSeen;
    }
    return res;
  }

  // Once the weights become infinite, more training can't recover them: stop, say why,
  // and only allow a reset.
  function setDiverged(on) {
    state.diverged = on;
    $("btn-train").disabled = on;
    $("btn-step").disabled = on;
    const alert = $("train-alert");
    alert.hidden = !on;
    alert.textContent = on
      ? `⚠ Training stopped: the weights blew up (became infinite) because the learning rate ` +
        `(${fmtLr(state.lr)}) is too high for this network. Lower the learning rate, then press “Reset weights” to start over.`
      : "";
    updateDrawWarning();
  }

  function evaluateTest() {
    const { data, net } = state;
    let correct = 0;
    for (let i = 0; i < data.nTest; i++) correct += net.predict(pixels(data.testX, i, testBuf)) === data.testY[i];
    state.testAcc = correct / data.nTest;
    state.lastEvalSeen = net.samplesSeen;
    chart.addTest(net.samplesSeen, 100 * state.testAcc);
    chart.draw();
    // A full epoch at chance level usually means the learning rate killed the neurons
    // (they all output the same thing). Training can continue, but say what's going on.
    if (!state.diverged) {
      const stuck = net.samplesSeen >= data.nTrain && state.testAcc < 0.2;
      const alert = $("train-alert");
      alert.hidden = !stuck;
      alert.textContent = stuck
        ? `⚠ Test accuracy is stuck near 10%, which is random guessing. The learning rate (${fmtLr(state.lr)}) ` +
          `is probably too high: big steps can push neurons into a state they never recover from. Lower it and press “Reset weights”.`
        : "";
    }
  }

  function renderLastTraining() {
    const L = state.last;
    if (!L || state.diverged) return;
    // net.a still holds this image's forward pass (backprop doesn't change it).
    trainView.show(state.net, { label: L.label });
    $("sample").value = L.i;
    $("sample-info").innerHTML =
      `Training on image <b>#${L.i + 1}</b>. Label <b>${L.label}</b>, network guessed <b>${L.predicted}</b> ` +
      (L.correct ? `<span class="ok">✓</span>` : `<span class="bad">✗</span>`) +
      ` · loss ${L.loss.toFixed(2)} <span class="muted">(then every weight was nudged to reduce it)</span>`;
  }

  function showTrainingImage(i) {
    const { data, net } = state;
    const label = data.trainY[i];
    const probs = net.forward(pixels(data.trainX, i, trainBuf));
    let pred = 0;
    for (let k = 1; k < 10; k++) if (probs[k] > probs[pred]) pred = k;
    trainView.show(net, { label });
    $("sample").value = i;
    $("sample-info").innerHTML =
      `Image <b>#${i + 1}</b> of ${data.nTrain.toLocaleString()}. Label <b>${label}</b>, network guesses <b>${pred}</b> ` +
      `(${pct(probs[pred])}) ` + (pred === label ? `<span class="ok">✓</span>` : `<span class="bad">✗</span>`);
  }

  function updateStats() {
    const net = state.net;
    $("st-epoch").textContent = state.epoch;
    $("st-epoch-sub").textContent = `one pass = ${state.data.nTrain.toLocaleString()} images`;
    $("st-seen").textContent = net.samplesSeen.toLocaleString();
    $("st-updates").textContent = fmtCount(net.samplesSeen * net.numParams());
    const r = recentAccuracy();
    $("st-recent").textContent = r == null ? "–" : pct(r);
    $("st-test").textContent = state.testAcc == null ? "–" : pct(state.testAcc);
    updateDrawWarning();
  }

  // The step 3 warning tracks training even while nothing is drawn on the pad.
  function updateDrawWarning() {
    const seen = state.net.samplesSeen;
    const warn = $("draw-warning");
    warn.hidden = !state.diverged && (seen >= 3000 || state.testAcc != null);
    warn.textContent = state.diverged
      ? "⚠ This network's weights blew up during training, so it can't classify anything. Reset it in step 2."
      : seen === 0
      ? "⚠ This network hasn't been trained yet, so its guesses are random. Train it in step 2 first. “As fast as possible” for a few seconds is enough."
      : `⚠ This network has only trained on ${seen.toLocaleString()} images so far, so its guesses are still rough. Train it some more in step 2.`;
  }

  function start() {
    if (state.diverged) return;
    state.running = true;
    state.lastTick = 0;
    state.owed = 1; // show the first image straight away
    $("btn-train").textContent = "Pause";
  }

  function pause({ evaluate = true } = {}) {
    const wasRunning = state.running;
    state.running = false;
    $("btn-train").textContent = state.net && state.net.samplesSeen && !state.diverged ? "Resume training" : "Start training";
    if (evaluate && wasRunning && state.net.samplesSeen !== state.lastEvalSeen) {
      evaluateTest();
      updateStats();
    }
  }

  function tick(now) {
    const dt = state.lastTick ? Math.min(250, now - state.lastTick) : 0;
    state.lastTick = now;
    if (state.running) {
      const rate = SPEEDS[+$("speed").value][0];
      let n = 0;
      if (rate === Infinity) {
        const t0 = performance.now();
        do { if (trainOne()) n++; } while (state.running && performance.now() - t0 < 14);
      } else {
        state.owed += (dt * rate) / 1000;
        const due = Math.min(Math.floor(state.owed), 2000);
        state.owed -= due;
        for (let k = 0; k < due && state.running; k++) if (trainOne()) n++;
      }
      if (n > 0) {
        renderLastTraining();
        if (state.evalPending) { state.evalPending = false; evaluateTest(); }
        updateStats();
        chart.draw();
        if (state.padHasInk && now - state.lastSketchUpdate > 400) {
          classifySketch();
          state.lastSketchUpdate = now;
        }
      }
    }
    requestAnimationFrame(tick);
  }

  // ---- sketch pad ------------------------------------------------------------
  const pad = $("pad"), padCtx = pad.getContext("2d", { willReadFrequently: true });
  function wipePad() {
    padCtx.fillStyle = "#000";
    padCtx.fillRect(0, 0, pad.width, pad.height);
    state.padHasInk = false;
  }
  function padPoint(e) {
    const r = pad.getBoundingClientRect();
    return [((e.clientX - r.left) * pad.width) / r.width, ((e.clientY - r.top) * pad.height) / r.height];
  }
  function strokeLine(a, b) {
    padCtx.strokeStyle = "#fff";
    padCtx.lineWidth = 20;
    padCtx.lineCap = "round";
    padCtx.lineJoin = "round";
    padCtx.beginPath();
    padCtx.moveTo(a[0], a[1]);
    padCtx.lineTo(b[0], b[1]);
    padCtx.stroke();
    state.padHasInk = true;
  }
  let drawing = false, lastPt = null, classifyQueued = false;
  function queueClassify() {
    if (classifyQueued) return;
    classifyQueued = true;
    requestAnimationFrame(() => { classifyQueued = false; classifySketch(); });
  }
  pad.addEventListener("pointerdown", (e) => {
    drawing = true;
    pad.setPointerCapture(e.pointerId);
    lastPt = padPoint(e);
    strokeLine(lastPt, lastPt);
    queueClassify();
  });
  pad.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const p = padPoint(e);
    strokeLine(lastPt, p);
    lastPt = p;
    queueClassify();
  });
  const endStroke = () => { drawing = false; queueClassify(); };
  pad.addEventListener("pointerup", endStroke);
  pad.addEventListener("pointercancel", endStroke);

  /**
   * Turn the 280x280 drawing into a 28x28 MNIST-style input, mirroring how MNIST
   * was made: crop to the ink, scale the longest side to 20px (keeping the aspect
   * ratio), place it in a 28x28 frame, then shift so the ink's centre of mass is
   * in the middle. Returns null if nothing is drawn.
   */
  function preprocessPad() {
    const S = pad.width, src = padCtx.getImageData(0, 0, S, S).data;
    const gray = new Float32Array(S * S);
    let minX = S, minY = S, maxX = -1, maxY = -1;
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const v = src[(y * S + x) * 4];
        gray[y * S + x] = v;
        if (v > 20) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    if (maxX < 0) return null;
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const scale = 20 / Math.max(bw, bh);
    const tw = Math.max(1, Math.round(bw * scale)), th = Math.max(1, Math.round(bh * scale));
    const img = new Float32Array(784);
    const ox = Math.floor((28 - tw) / 2), oy = Math.floor((28 - th) / 2);
    // Area-average each target pixel over the source pixels it covers.
    for (let ty = 0; ty < th; ty++) {
      const y0 = minY + Math.floor(ty / scale), y1 = Math.max(y0 + 1, minY + Math.floor((ty + 1) / scale));
      for (let tx = 0; tx < tw; tx++) {
        const x0 = minX + Math.floor(tx / scale), x1 = Math.max(x0 + 1, minX + Math.floor((tx + 1) / scale));
        let sum = 0, count = 0;
        for (let y = y0; y < Math.min(y1, S); y++)
          for (let x = x0; x < Math.min(x1, S); x++) { sum += gray[y * S + x]; count++; }
        img[(oy + ty) * 28 + ox + tx] = count ? sum / count / 255 : 0;
      }
    }
    // Centre of mass -> shift to the middle of the frame.
    let m = 0, cx = 0, cy = 0;
    for (let p = 0; p < 784; p++) { m += img[p]; cx += (p % 28) * img[p]; cy += ((p / 28) | 0) * img[p]; }
    const dx = Math.round(13.5 - cx / m), dy = Math.round(13.5 - cy / m);
    const out = new Float32Array(784);
    for (let y = 0; y < 28; y++)
      for (let x = 0; x < 28; x++) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < 28 && ny >= 0 && ny < 28) out[ny * 28 + nx] = img[y * 28 + x];
      }
    return out;
  }

  function drawPreview(x) {
    const ctx = $("pad-preview").getContext("2d"), img = ctx.createImageData(28, 28);
    for (let p = 0; p < 784; p++) {
      const v = x ? Math.round(x[p] * 255) : 0;
      img.data.set([v, v, v, 255], p * 4);
    }
    ctx.putImageData(img, 0, 0);
  }

  function classifySketch() {
    if (!state.net || !drawView) return;
    const x = state.padHasInk ? preprocessPad() : null;
    drawPreview(x);
    updateDrawWarning();
    if (!x) {
      drawView.clear(state.net);
      $("guess-digit").textContent = "?";
      $("guess-conf").textContent = "Draw a digit (0–9) in the box";
      return;
    }
    const probs = state.net.forward(x);
    const order = Array.from(probs.keys()).sort((a, b) => probs[b] - probs[a]);
    drawView.show(state.net, {});
    $("guess-digit").textContent = order[0];
    $("guess-conf").textContent = `${pct(probs[order[0]])} confident · runner-up: ${order[1]} (${pct(probs[order[1]])})`;
  }

  // ---- wiring ------------------------------------------------------------------
  function redrawAll() {
    theme.refresh();
    describeActivation();
    trainView.draw();
    drawView.draw();
    chart.draw();
  }

  async function init() {
    theme.refresh();
    trainView = new NetworkView($("net-train"));
    drawView = new NetworkView($("net-draw"));
    chart = new AccuracyChart($("acc-chart"));

    const actSelect = $("activation");
    for (const [key, act] of Object.entries(ACTIVATIONS)) actSelect.add(new Option(act.label, key));
    actSelect.value = "sigmoid";
    describeActivation();
    new ResizeObserver(() => drawActivationPlot($("act-canvas"), ACTIVATIONS[actSelect.value])).observe($("act-canvas"));

    const speed = $("speed");
    const showSpeed = () => ($("speed-out").textContent = SPEEDS[+speed.value][1]);
    speed.addEventListener("input", showSpeed);
    showSpeed();
    $("lr").addEventListener("input", (e) =>
      setLr(10 ** (LR_MIN_LOG + ((LR_MAX_LOG - LR_MIN_LOG) * e.target.value) / 1000)));

    wipePad();
    try {
      state.data = await loadData();
    } catch (err) {
      $("loading").textContent = err.message;
      $("loading").classList.add("error");
      return;
    }
    $("loading").hidden = true;
    document.body.classList.add("ready");
    $("sample").max = state.data.nTrain - 1;

    actSelect.addEventListener("change", () => { describeActivation(); buildNetwork(); });
    $("arch").addEventListener("change", () => buildNetwork({ keepLr: true }));
    $("btn-train").addEventListener("click", () => (state.running ? pause() : start()));
    $("btn-step").addEventListener("click", () => {
      pause({ evaluate: false });
      if (trainOne()) {
        renderLastTraining();
        if (state.evalPending) { state.evalPending = false; evaluateTest(); }
        updateStats();
        chart.draw();
        classifySketch();
        $("btn-train").textContent = "Resume training";
      }
    });
    $("btn-reset").addEventListener("click", () => { state.seed++; buildNetwork({ keepLr: true }); });
    $("sample").addEventListener("input", (e) => {
      pause();
      state.cursor = +e.target.value;
      showTrainingImage(state.cursor);
    });
    $("btn-clear").addEventListener("click", () => { wipePad(); classifySketch(); });
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", redrawAll);

    buildNetwork();
    requestAnimationFrame(tick);
  }

  init();
})();
