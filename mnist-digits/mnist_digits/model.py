"""DigitCNN: a small convolutional network built from the NumPy layers."""

from pathlib import Path

import numpy as np

from .layers import Conv2D, Dense, Dropout, Flatten, MaxPool2D, Sigmoid, softmax


class DigitCNN:
    """
    Input [N, 1, 28, 28]
      Conv(1->16, 3x3)  + Sigmoid + MaxPool  -> [N, 16, 14, 14]
      Conv(16->32, 3x3) + Sigmoid + MaxPool  -> [N, 32, 7, 7]
      Flatten                                -> [N, 1568]
      Dense(1568->128)  + Sigmoid + Dropout  -> [N, 128]
      Dense(128->10)                         -> [N, 10] logits
    """

    def __init__(self, num_classes=10, dropout=0.25, seed=0):
        rng = np.random.default_rng(seed)
        self.layers = [
            Conv2D(1, 16, rng=rng), Sigmoid(), MaxPool2D(),
            Conv2D(16, 32, rng=rng), Sigmoid(), MaxPool2D(),
            Flatten(),
            Dense(32 * 7 * 7, 128, rng=rng), Sigmoid(), Dropout(dropout, rng=rng),
            Dense(128, num_classes, rng=rng),
        ]

    def forward(self, x: np.ndarray, training: bool = False) -> np.ndarray:
        for layer in self.layers:
            x = layer.forward(x, training)
        return x

    def backward(self, dlogits: np.ndarray) -> None:
        """Backpropagation: pass the gradient through the layers in reverse."""
        grad = dlogits
        for layer in reversed(self.layers):
            grad = layer.backward(grad)

    def predict_proba(self, x: np.ndarray, batch_size: int = 500) -> np.ndarray:
        return np.concatenate(
            [softmax(self.forward(x[i:i + batch_size])) for i in range(0, len(x), batch_size)]
        )

    def activations(self, x: np.ndarray):
        """Run inference and capture every hidden layer's output.

        Returns (hidden, probs): hidden is a list with one array per Sigmoid
        layer, i.e. what each hidden layer "sees"; probs are the class probabilities.
        """
        hidden = []
        for layer in self.layers:
            x = layer.forward(x, training=False)
            if isinstance(layer, Sigmoid):
                hidden.append(x)
        return hidden, softmax(x)

    def named_params(self):
        """Yield (name, weights, gradients) for every learnable array."""
        for i, layer in enumerate(self.layers):
            for name, p in layer.params.items():
                yield f"layer{i}.{name}", p, layer.grads.get(name)

    def num_params(self) -> int:
        return sum(p.size for _, p, _ in self.named_params())

    def save(self, path: Path, **metadata) -> None:
        arrays = {name: p for name, p, _ in self.named_params()}
        np.savez(path, **arrays, **{f"meta.{k}": np.asarray(v) for k, v in metadata.items()})

    def load(self, path: Path) -> dict:
        with np.load(path) as data:
            for name, p, _ in self.named_params():
                if data[name].shape != p.shape:
                    raise ValueError(f"{name}: checkpoint shape {data[name].shape} != {p.shape}")
                p[...] = data[name]
            return {k[5:]: data[k].item() for k in data.files if k.startswith("meta.")}
