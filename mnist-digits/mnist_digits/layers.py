"""Neural network layers written with NumPy only.

Every layer has:
    forward(x, training)  -> output, caching whatever backward() needs
    backward(dout)        -> gradient w.r.t. the input, storing gradients of
                             its own weights in self.grads
Layers with weights keep them in self.params (and matching self.grads).
"""

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view


class Layer:
    def __init__(self):
        self.params: dict[str, np.ndarray] = {}
        self.grads: dict[str, np.ndarray] = {}

    def forward(self, x: np.ndarray, training: bool) -> np.ndarray:
        raise NotImplementedError

    def backward(self, dout: np.ndarray) -> np.ndarray:
        raise NotImplementedError


def _glorot(rng, shape, fan_in, fan_out):
    """Xavier/Glorot uniform init: keeps signal variance stable through sigmoid layers."""
    limit = np.sqrt(6.0 / (fan_in + fan_out))
    return rng.uniform(-limit, limit, size=shape).astype(np.float32)


class Conv2D(Layer):
    """2D convolution (stride 1) implemented as one matrix multiplication.

    "im2col": every k x k patch of the input is unrolled into a row, so the
    convolution becomes  patches @ filters.T  — a single matrix multiply.
    """

    def __init__(self, in_channels, out_channels, kernel_size=3, padding=1, rng=None):
        super().__init__()
        rng = rng or np.random.default_rng()
        k = kernel_size
        self.k, self.pad = k, padding
        self.params["W"] = _glorot(
            rng, (out_channels, in_channels, k, k), in_channels * k * k, out_channels * k * k
        )
        self.params["b"] = np.zeros(out_channels, dtype=np.float32)

    def forward(self, x, training):
        n, c, h, w = x.shape
        k, p = self.k, self.pad
        xp = np.pad(x, ((0, 0), (0, 0), (p, p), (p, p)))
        ho, wo = h + 2 * p - k + 1, w + 2 * p - k + 1
        # (N, C, Ho, Wo, k, k) view of every patch -> rows of length C*k*k
        windows = sliding_window_view(xp, (k, k), axis=(2, 3))
        cols = windows.transpose(0, 2, 3, 1, 4, 5).reshape(n * ho * wo, c * k * k)

        W = self.params["W"]
        w_mat = W.reshape(W.shape[0], -1)                     # (F, C*k*k)
        out = cols @ w_mat.T + self.params["b"]               # (N*Ho*Wo, F)

        self.cache = (x.shape, xp.shape, cols, ho, wo)
        return out.reshape(n, ho, wo, -1).transpose(0, 3, 1, 2)

    def backward(self, dout):
        (n, c, h, w), xp_shape, cols, ho, wo = self.cache
        k, p = self.k, self.pad
        W = self.params["W"]
        f = W.shape[0]

        dout_mat = dout.transpose(0, 2, 3, 1).reshape(-1, f)  # (N*Ho*Wo, F)
        self.grads["W"] = (dout_mat.T @ cols).reshape(W.shape)
        self.grads["b"] = dout_mat.sum(axis=0)

        # Gradient for each patch row, then "col2im": add each patch back to
        # the pixels it came from (patches overlap, so contributions sum).
        dcols = (dout_mat @ W.reshape(f, -1)).reshape(n, ho, wo, c, k, k)
        dxp = np.zeros(xp_shape, dtype=dout.dtype)
        for i in range(k):
            for j in range(k):
                dxp[:, :, i:i + ho, j:j + wo] += dcols[:, :, :, :, i, j].transpose(0, 3, 1, 2)
        return dxp[:, :, p:p + h, p:p + w]


class Sigmoid(Layer):
    """sigmoid(x) = 1 / (1 + e^-x), squashing every value into (0, 1)."""

    def forward(self, x, training):
        # Written via tanh so very negative inputs don't overflow exp().
        self.out = 0.5 * (1.0 + np.tanh(0.5 * x))
        return self.out

    def backward(self, dout):
        # d/dx sigmoid(x) = sigmoid(x) * (1 - sigmoid(x))
        return dout * self.out * (1.0 - self.out)


class MaxPool2D(Layer):
    """2x2 max pooling with stride 2 (input height/width must be even)."""

    def forward(self, x, training):
        n, c, h, w = x.shape
        xr = x.reshape(n, c, h // 2, 2, w // 2, 2)
        out = xr.max(axis=(3, 5))
        # Remember which element in each 2x2 window was the max.
        self.mask = xr == out[:, :, :, None, :, None]
        self.in_shape = x.shape
        return out

    def backward(self, dout):
        # Gradient flows only to the element that was the max in its window.
        return (self.mask * dout[:, :, :, None, :, None]).reshape(self.in_shape)


class Flatten(Layer):
    def forward(self, x, training):
        self.in_shape = x.shape
        return x.reshape(x.shape[0], -1)

    def backward(self, dout):
        return dout.reshape(self.in_shape)


class Dense(Layer):
    """Fully connected layer: out = x @ W + b."""

    def __init__(self, in_features, out_features, rng=None):
        super().__init__()
        rng = rng or np.random.default_rng()
        self.params["W"] = _glorot(rng, (in_features, out_features), in_features, out_features)
        self.params["b"] = np.zeros(out_features, dtype=np.float32)

    def forward(self, x, training):
        self.x = x
        return x @ self.params["W"] + self.params["b"]

    def backward(self, dout):
        self.grads["W"] = self.x.T @ dout
        self.grads["b"] = dout.sum(axis=0)
        return dout @ self.params["W"].T


class Dropout(Layer):
    """Randomly zero a fraction p of values during training (inverted dropout)."""

    def __init__(self, p=0.5, rng=None):
        super().__init__()
        self.p = p
        self.rng = rng or np.random.default_rng()

    def forward(self, x, training):
        if not training or self.p == 0:
            self.mask = None
            return x
        keep = self.rng.random(x.shape) >= self.p
        self.mask = (keep / (1.0 - self.p)).astype(x.dtype)
        return x * self.mask

    def backward(self, dout):
        return dout if self.mask is None else dout * self.mask


def softmax(logits: np.ndarray) -> np.ndarray:
    shifted = logits - logits.max(axis=1, keepdims=True)  # avoid overflow in exp
    e = np.exp(shifted)
    return e / e.sum(axis=1, keepdims=True)


def softmax_cross_entropy(logits: np.ndarray, labels: np.ndarray):
    """Mean cross-entropy loss and its gradient w.r.t. the logits."""
    n = logits.shape[0]
    probs = softmax(logits)
    loss = -np.log(probs[np.arange(n), labels] + 1e-12).mean()
    dlogits = probs.copy()
    dlogits[np.arange(n), labels] -= 1.0      # softmax - one_hot(labels)
    return float(loss), dlogits / n
