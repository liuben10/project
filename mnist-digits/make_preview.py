"""Generate web/og-image.png, the 1200x630 preview shown when the page is shared.

Social sites (Reddit, Slack, LinkedIn, X) show this image from the page's
og:image tag. Rerun after changing the page's look:

    python make_preview.py
"""

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from matplotlib.colors import LinearSegmentedColormap, to_rgb  # noqa: E402

from mnist_digits.data import DEFAULT_DATA_DIR, _read_idx, load_mnist  # noqa: E402

OUT = Path("web/og-image.png")
W, H = 1200, 630

# Same palette as the page (light mode).
BG, NEUTRAL, BORDER = "#f9f9f7", "#f0efec", "#e4e3df"
INK, INK2, MUTED = "#0b0b0b", "#52514e", "#8a8984"
POS, POS_MAX, NEG = "#2a78d6", "#104281", "#e34948"
RAMP = LinearSegmentedColormap.from_list("act", [NEUTRAL, POS, POS_MAX])


def main():
    load_mnist(DEFAULT_DATA_DIR)  # downloads the raw files if missing
    digit = _read_idx(DEFAULT_DATA_DIR / "t10k-images-idx3-ubyte.gz")[0] / 255.0  # a "7"
    rng = np.random.default_rng(7)

    fig = plt.figure(figsize=(W / 100, H / 100), dpi=100, facecolor=BG)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, W)
    ax.set_ylim(H, 0)
    ax.axis("off")

    # ---- text --------------------------------------------------------------
    ax.text(64, 150, "Inside a\nNeural Network", fontsize=50, fontweight="bold",
            color=INK, va="center", linespacing=1.05)
    ax.text(66, 330, "Watch a network learn to read\nhandwriting, one neuron at a time.\n"
            "Then draw a digit and see what lights up.",
            fontsize=19, color=INK2, va="center", linespacing=1.45)
    ax.text(66, 470, "Interactive  ·  built from scratch  ·  runs in your browser",
            fontsize=16, color=POS, fontweight="bold", va="center")
    ax.plot([66, 520], [530, 530], color=BORDER, lw=1.5)
    ax.text(66, 565, "MNIST handwritten digits  ·  5 activation functions  ·  live training",
            fontsize=14, color=MUTED, va="center")

    # ---- network diagram ---------------------------------------------------
    grid_x, grid_y, cell = 655, 235, 6.0
    size = 28 * cell
    ax.imshow(digit, cmap=RAMP, vmin=0, vmax=1, interpolation="nearest",
              extent=(grid_x, grid_x + size, grid_y + size, grid_y), zorder=2)
    ax.add_patch(plt.Rectangle((grid_x, grid_y), size, size, fill=False, ec=BORDER, lw=1.5, zorder=3))

    cols = [(910, 14), (1010, 10), (1105, 10)]
    top, bottom = 70, 570
    ys = [np.linspace(top + (bottom - top) / n / 2, bottom - (bottom - top) / n / 2, n) for _, n in cols]
    acts = [rng.beta(0.6, 0.9, 14), rng.beta(0.6, 0.9, 10), np.full(10, 0.02)]
    acts[2][7] = 0.96  # the network says "7"

    # input -> hidden 1: a faint fan, as on the page
    for k in range(7):
        y0 = grid_y + size * (k + 0.5) / 7
        for y in ys[0]:
            ax.plot([grid_x + size + 2, cols[0][0] - 12], [y0, y], color=MUTED, alpha=0.10, lw=0.7, zorder=1)
    # hidden -> hidden -> output, coloured by signal
    for l in range(2):
        (x0, n0), (x1, n1) = cols[l], cols[l + 1]
        w = rng.normal(0, 1, (n1, n0))
        signal = w * acts[l][None, :]
        signal[:, :] *= 1 + 2.5 * (acts[l + 1][:, None])  # stronger into active neurons
        m = np.abs(signal).max()
        for o in range(n1):
            for i in range(n0):
                t = abs(signal[o, i]) / m
                if t < 0.12:
                    continue
                ax.plot([x0 + 10, x1 - 12], [ys[l][i], ys[l + 1][o]],
                        color=POS if signal[o, i] > 0 else NEG, alpha=0.15 + 0.7 * t,
                        lw=0.5 + 2.2 * t, zorder=1, solid_capstyle="round")
    for (x, n), y_col, a in zip(cols, ys, acts):
        r = 12 if n == 10 and x == cols[-1][0] else 10
        for y, v in zip(y_col, a):
            ax.add_patch(plt.Circle((x, y), r, fc=RAMP(v), ec=BORDER, lw=1.2, zorder=4))
    for k, y in enumerate(ys[2]):
        ax.text(cols[2][0] + 22, y, str(k), fontsize=14, va="center",
                color=INK if k == 7 else INK2, fontweight="bold" if k == 7 else "normal")

    OUT.parent.mkdir(exist_ok=True)
    fig.savefig(OUT, dpi=100, facecolor=BG)
    print(f"Wrote {OUT} ({OUT.stat().st_size / 1e3:.0f} KB)")


if __name__ == "__main__":
    main()
