"""Adam optimizer: decides how to update each weight from its gradient."""

import math

import numpy as np


class Adam:
    """Adam with decoupled weight decay (AdamW).

    For each weight it keeps a running average of the gradient (m, "momentum")
    and of the squared gradient (v). The update  m / sqrt(v)  gives every
    weight its own effective step size.
    """

    def __init__(self, model, lr=1e-3, betas=(0.9, 0.999), eps=1e-8, weight_decay=0.0):
        self.model = model
        self.lr, self.eps, self.weight_decay = lr, eps, weight_decay
        self.b1, self.b2 = betas
        self.t = 0
        self.m = {name: np.zeros_like(p) for name, p, _ in model.named_params()}
        self.v = {name: np.zeros_like(p) for name, p, _ in model.named_params()}

    def step(self, lr=None):
        lr = self.lr if lr is None else lr
        self.t += 1
        bc1 = 1 - self.b1 ** self.t   # bias correction: m and v start at 0
        bc2 = 1 - self.b2 ** self.t
        for name, p, g in self.model.named_params():
            if self.weight_decay and p.ndim > 1:     # don't decay biases
                p -= lr * self.weight_decay * p
            m, v = self.m[name], self.v[name]
            m *= self.b1
            m += (1 - self.b1) * g
            v *= self.b2
            v += (1 - self.b2) * g * g
            p -= (lr / bc1) * m / (np.sqrt(v / bc2) + self.eps)


def cosine_lr(step: int, total_steps: int, peak_lr: float, warmup_steps: int = 0) -> float:
    """Short linear warm-up, then smoothly decay the learning rate to 0."""
    if step < warmup_steps:
        return peak_lr * (step + 1) / warmup_steps
    progress = (step - warmup_steps) / max(1, total_steps - warmup_steps)
    return peak_lr * 0.5 * (1 + math.cos(math.pi * progress))
