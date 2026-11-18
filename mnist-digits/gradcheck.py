"""Check the hand-written backpropagation against numerical derivatives.

For randomly chosen weights w, compare the analytic gradient from
model.backward() with the slope  (loss(w + h) - loss(w - h)) / 2h.
They should agree to many decimal places. Run:  python gradcheck.py

Max pooling has "kinks": if a nudge of size h changes which value wins a
2x2 window, the numeric slope is wrong. On a mismatch we retry with a much
smaller h, which steps over the kink.
"""

import numpy as np

from mnist_digits.layers import softmax_cross_entropy
from mnist_digits.model import DigitCNN

TOLERANCE = 1e-5


def main():
    rng = np.random.default_rng(0)
    model = DigitCNN(dropout=0.0, seed=1)
    # float64 so the finite differences are precise enough to compare.
    for layer in model.layers:
        for k in layer.params:
            layer.params[k] = layer.params[k].astype(np.float64)

    x = rng.standard_normal((4, 1, 28, 28))
    y = rng.integers(0, 10, size=4)

    def loss_fn():
        return softmax_cross_entropy(model.forward(x, training=True), y)[0]

    # Analytic gradients: one forward + backward pass. The backward loop is
    # written out here so we also get the gradient w.r.t. the input image.
    _, grad = softmax_cross_entropy(model.forward(x, training=True), y)
    for layer in reversed(model.layers):
        grad = layer.backward(grad)
    dx = grad

    def rel_error(array, index, analytic):
        best = np.inf
        for h in (1e-5, 1e-7):
            old = array[index]
            array[index] = old + h
            up = loss_fn()
            array[index] = old - h
            down = loss_fn()
            array[index] = old
            numeric = (up - down) / (2 * h)
            err = abs(numeric - analytic) / max(1e-10, abs(numeric) + abs(analytic))
            best = min(best, err)
            if best < TOLERANCE:
                break
        return best

    checks = [(name, p, g) for name, p, g in model.named_params()] + [("input", x, dx)]
    worst = 0.0
    for name, array, analytic in checks:
        errs = []
        for _ in range(10):
            i = tuple(int(rng.integers(0, s)) for s in array.shape)
            errs.append(rel_error(array, i, analytic[i]))
        worst = max(worst, max(errs))
        status = "ok" if max(errs) < TOLERANCE else "MISMATCH"
        print(f"{name:10s} {str(array.shape):18s} max rel err {max(errs):.1e}  {status}")

    if worst >= TOLERANCE:
        raise SystemExit(f"Gradient check FAILED (max relative error {worst:.1e})")
    print("All gradients match.")


if __name__ == "__main__":
    main()
