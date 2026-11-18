// A fully-connected neural network written from scratch: no ML libraries.
// Works in the browser (window.NN) and in Node (module.exports) for testing.
(function (root) {
  "use strict";

  // Each activation: the function f(z), its derivative (given z and a = f(z)),
  // the range its output can take (null = unbounded), how to initialise
  // weights for it, and a learning rate that trains well with it.
  const ACTIVATIONS = {
    sigmoid: {
      label: "Sigmoid",
      formula: "σ(x) = 1 / (1 + e^(−x))",
      range: [0, 1],
      init: "xavier",
      lr: 0.1,
      f: (x) => 1 / (1 + Math.exp(-x)),
      df: (z, a) => a * (1 - a),
      about:
        "Squashes any input into 0…1, like a soft on/off switch. Its slope is never above 0.25 and " +
        "almost 0 for large inputs, so the error signal fades as it travels back through layers " +
        "(the “vanishing gradient”). It learns, but slowly.",
    },
    tanh: {
      label: "Tanh",
      formula: "tanh(x) = (e^x − e^(−x)) / (e^x + e^(−x))",
      range: [-1, 1],
      init: "xavier",
      lr: 0.01,
      f: Math.tanh,
      df: (z, a) => 1 - a * a,
      about:
        "An S-curve like sigmoid, but from −1 to 1 and centred on 0, so neurons can push " +
        "the next layer both up and down. Its slope reaches 1, so it usually learns faster than sigmoid.",
    },
    relu: {
      label: "ReLU",
      formula: "ReLU(x) = max(0, x)",
      range: null,
      init: "he",
      lr: 0.01,
      f: (x) => (x > 0 ? x : 0),
      df: (z) => (z > 0 ? 1 : 0),
      about:
        "Passes positive values straight through and outputs 0 otherwise. Its slope is exactly 1 " +
        "for active neurons, so error signals don't fade. It's the default in modern networks. " +
        "A neuron stuck below 0 for every input stops learning (a “dead” neuron).",
    },
    leaky_relu: {
      label: "Leaky ReLU",
      formula: "LeakyReLU(x) = x if x > 0, else 0.05·x",
      range: null,
      init: "he",
      lr: 0.01,
      f: (x) => (x > 0 ? x : 0.05 * x),
      df: (z) => (z > 0 ? 1 : 0.05),
      about:
        "Like ReLU, but lets a small trickle through for negative inputs, so a neuron can " +
        "always recover instead of dying.",
    },
    linear: {
      label: "None (linear)",
      formula: "f(x) = x",
      range: null,
      init: "xavier",
      lr: 0.003,
      f: (x) => x,
      df: () => 1,
      about:
        "No activation at all. Stacked layers then collapse into one big linear function, " +
        "so extra layers add nothing. On MNIST it still reaches about 90%, since many digits " +
        "are separable by straight lines, but it levels off a few points below the others: " +
        "the non-linear “bend” is what lets networks learn more complex shapes.",
    },
  };

  // Small seeded random generator so a given seed always builds the same network.
  function mulberry32(seed) {
    let t = seed >>> 0;
    return function () {
      t = (t + 0x6d2b79f5) >>> 0;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  function gaussian(rand) {
    // Box-Muller transform: two uniform numbers -> one normally distributed number.
    let u = 0;
    while (u === 0) u = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  }

  class MLP {
    /**
     * @param {number[]} sizes  e.g. [784, 32, 16, 10]
     * @param {string} activation  key of ACTIVATIONS, used by every hidden layer
     */
    constructor(sizes, activation = "relu", seed = 1) {
      this.sizes = sizes.slice();
      this.activationName = activation;
      this.act = ACTIVATIONS[activation];
      this.samplesSeen = 0;
      const rand = mulberry32(seed);
      const L = sizes.length - 1;

      this.W = []; // W[l][o * nIn + i] = weight from neuron i (layer l) to neuron o (layer l+1)
      this.b = [];
      this.z = []; // weighted sums before the activation, per layer
      this.a = [null]; // activations; a[0] is the input image
      this.delta = []; // error signal per layer during backprop
      for (let l = 0; l < L; l++) {
        const nIn = sizes[l], nOut = sizes[l + 1];
        const isOutput = l === L - 1;
        // He init keeps ReLU signals from shrinking; Xavier suits S-shaped curves.
        const std = !isOutput && this.act.init === "he"
          ? Math.sqrt(2 / nIn)
          : Math.sqrt(2 / (nIn + nOut));
        const W = new Float32Array(nIn * nOut);
        for (let k = 0; k < W.length; k++) W[k] = gaussian(rand) * std;
        this.W.push(W);
        this.b.push(new Float32Array(nOut));
        this.z.push(new Float32Array(nOut));
        this.a.push(new Float32Array(nOut));
        this.delta.push(new Float32Array(nOut));
      }
    }

    numParams() {
      return this.W.reduce((s, W) => s + W.length, 0) + this.b.reduce((s, b) => s + b.length, 0);
    }

    /** Forward pass. x: Float32Array(784) with pixels in 0..1. Returns class probabilities. */
    forward(x) {
      const L = this.W.length;
      this.a[0] = x;
      for (let l = 0; l < L; l++) {
        const inA = this.a[l], W = this.W[l], b = this.b[l], z = this.z[l], out = this.a[l + 1];
        const nIn = inA.length, nOut = out.length;
        for (let o = 0; o < nOut; o++) {
          let sum = b[o];
          const row = o * nIn;
          for (let i = 0; i < nIn; i++) sum += W[row + i] * inA[i];
          z[o] = sum;
        }
        if (l < L - 1) {
          const f = this.act.f;
          for (let o = 0; o < nOut; o++) out[o] = f(z[o]);
        } else {
          // Softmax: turn the 10 output scores into probabilities that add up to 1.
          let max = -Infinity;
          for (let o = 0; o < nOut; o++) max = Math.max(max, z[o]);
          let total = 0;
          for (let o = 0; o < nOut; o++) total += (out[o] = Math.exp(z[o] - max));
          for (let o = 0; o < nOut; o++) out[o] /= total;
        }
      }
      return this.a[L];
    }

    predict(x) {
      const p = this.forward(x);
      let best = 0;
      for (let k = 1; k < p.length; k++) if (p[k] > p[best]) best = k;
      return best;
    }

    /**
     * Compute gradients for one sample by backpropagation; optionally apply them.
     * Returns { loss, predicted, correct }. With lr = 0 nothing changes (used by tests).
     */
    trainSample(x, label, lr) {
      const probs = this.forward(x);
      const L = this.W.length;
      let predicted = 0;
      for (let k = 1; k < probs.length; k++) if (probs[k] > probs[predicted]) predicted = k;
      const loss = -Math.log(probs[label] + 1e-12);

      // Output error for softmax + cross-entropy: probabilities minus the one-hot target.
      const dOut = this.delta[L - 1];
      for (let o = 0; o < dOut.length; o++) dOut[o] = probs[o] - (o === label ? 1 : 0);

      for (let l = L - 1; l >= 0; l--) {
        const inA = this.a[l], W = this.W[l], b = this.b[l], d = this.delta[l];
        const nIn = inA.length, nOut = d.length;
        // Pass the error back to the previous layer *before* changing these weights.
        if (l > 0) {
          const dPrev = this.delta[l - 1], zPrev = this.z[l - 1], aPrev = this.a[l];
          dPrev.fill(0);
          for (let o = 0; o < nOut; o++) {
            const dv = d[o], row = o * nIn;
            for (let i = 0; i < nIn; i++) dPrev[i] += W[row + i] * dv;
          }
          const df = this.act.df;
          for (let i = 0; i < nIn; i++) dPrev[i] *= df(zPrev[i], aPrev[i]);
        }
        if (lr > 0) {
          // Gradient descent: nudge every weight against its share of the error.
          for (let o = 0; o < nOut; o++) {
            const step = lr * d[o], row = o * nIn;
            if (step === 0) continue;
            for (let i = 0; i < nIn; i++) {
              const v = inA[i];
              if (v !== 0) W[row + i] -= step * v;
            }
            b[o] -= step;
          }
        }
      }
      if (lr > 0) this.samplesSeen++;
      return { loss, predicted, correct: predicted === label };
    }
  }

  const NN = { MLP, ACTIVATIONS };
  root.NN = NN;
  if (typeof module !== "undefined" && module.exports) module.exports = NN;
})(typeof window !== "undefined" ? window : globalThis);
