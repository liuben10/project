"""Heatmaps of every hidden layer's activations for one or more digits.

Usage:
    python visualize.py                       # test image #0
    python visualize.py --index 0 7 42        # several MNIST test images
    python visualize.py my_digit.png          # your own image
    python visualize.py --show                # also open a window

Each output PNG shows, top to bottom:
    the input image and the model's prediction,
    conv layer 1: 16 feature maps (28x28), one per filter,
    conv layer 2: 32 feature maps (14x14),
    dense layer: the 128 hidden neurons laid out as an 8x16 grid.
All activations are sigmoid outputs, so they share one 0-1 colour scale:
light = the neuron is barely firing, dark blue = firing strongly.
"""

import argparse
from pathlib import Path

import matplotlib

import numpy as np

from mnist_digits.data import DEFAULT_DATA_DIR, _read_idx, normalize
from mnist_digits.model import DigitCNN

# Sequential single-hue ramp (light -> dark blue) and chart inks.
RAMP = ["#fcfcfb", "#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5",
        "#256abf", "#184f95", "#104281", "#0d366b"]
SURFACE = "#fcfcfb"
INK = "#0b0b0b"
INK_SECONDARY = "#52514e"
INK_MUTED = "#8a8984"
BAR = "#9ec5f4"
BAR_HIGHLIGHT = "#256abf"


def make_figure(image, hidden, probs, title):
    import matplotlib.pyplot as plt
    from matplotlib.colors import LinearSegmentedColormap

    cmap = LinearSegmentedColormap.from_list("activation", RAMP)
    plt.rcParams.update({
        "font.size": 10, "text.color": INK, "axes.labelcolor": INK_SECONDARY,
        "xtick.color": INK_SECONDARY, "ytick.color": INK_SECONDARY,
    })
    conv1, conv2, dense = hidden[0][0], hidden[1][0], hidden[2][0]

    fig = plt.figure(figsize=(13, 15), facecolor=SURFACE, layout="constrained")
    fig.suptitle(title, fontsize=15, fontweight="bold", color=INK)
    top, sf1, sf2, sf3 = fig.subfigures(4, 1, height_ratios=[1.0, 0.95, 1.55, 1.0])
    for sf in (top, sf1, sf2, sf3):
        sf.set_facecolor(SURFACE)

    # --- Input + prediction + colour scale -------------------------------
    ax_in, ax_prob, ax_cbar = top.subplots(
        1, 3, gridspec_kw={"width_ratios": [1, 2.2, 0.08]}
    )
    ax_in.imshow(image, cmap="gray", interpolation="nearest")
    ax_in.set_title("Input (28×28)", color=INK)
    ax_in.axis("off")

    pred = int(probs.argmax())
    colors = [BAR_HIGHLIGHT if d == pred else BAR for d in range(10)]
    ax_prob.bar(range(10), probs, color=colors, width=0.6)
    ax_prob.set_xticks(range(10))
    ax_prob.set_ylim(0, 1.12)
    ax_prob.set_yticks([0, 0.5, 1.0], ["0%", "50%", "100%"])
    ax_prob.set_xlabel("Digit")
    ax_prob.set_title(f"Prediction: {pred}  ({probs[pred]:.1%} confident)", color=INK)
    ax_prob.text(pred, probs[pred] + 0.03, f"{probs[pred]:.0%}",
                 ha="center", va="bottom", color=INK, fontsize=9)
    ax_prob.grid(axis="y", color="#e4e3df", linewidth=0.8)
    ax_prob.set_axisbelow(True)
    for side in ("top", "right", "left"):
        ax_prob.spines[side].set_visible(False)
    ax_prob.spines["bottom"].set_color(INK_MUTED)
    ax_prob.tick_params(length=0)
    ax_prob.set_facecolor(SURFACE)

    mappable = matplotlib.cm.ScalarMappable(
        norm=matplotlib.colors.Normalize(0, 1), cmap=cmap
    )
    cbar = top.colorbar(mappable, cax=ax_cbar)
    cbar.set_label("Activation (sigmoid output)")
    cbar.outline.set_visible(False)

    # --- Feature-map grids ------------------------------------------------
    def grid(subfig, maps, rows, cols, heading):
        subfig.suptitle(heading, fontsize=12, color=INK, x=0.01, ha="left")
        axes = subfig.subplots(rows, cols, gridspec_kw={"wspace": 0.06, "hspace": 0.06})
        for i, ax in enumerate(axes.flat):
            ax.imshow(maps[i], cmap=cmap, vmin=0, vmax=1, interpolation="nearest")
            ax.set_xticks([]); ax.set_yticks([])
            for s in ax.spines.values():
                s.set_visible(False)
            ax.text(0.03, 0.97, str(i), transform=ax.transAxes, va="top", ha="left",
                    fontsize=7, color=INK,
                    bbox={"boxstyle": "square,pad=0.15", "facecolor": SURFACE,
                          "edgecolor": "none", "alpha": 0.85})

    grid(sf1, conv1, 2, 8,
         "Conv layer 1 — 16 filters, each a 28×28 map of where its pattern (edges, strokes) appears")
    grid(sf2, conv2, 4, 8,
         "Conv layer 2 — 32 filters on 14×14, combining layer-1 patterns into larger shapes")

    # --- Dense layer as one heatmap ---------------------------------------
    sf3.suptitle("Dense layer — 128 hidden neurons (8 × 16 grid, numbered left→right, top→bottom)",
                 fontsize=12, color=INK, x=0.01, ha="left")
    ax_d = sf3.subplots()
    ax_d.imshow(dense.reshape(8, 16), cmap=cmap, vmin=0, vmax=1, interpolation="nearest")
    ax_d.set_xticks(range(16))
    ax_d.set_yticks(range(8), [str(r * 16) for r in range(8)])
    ax_d.set_xlabel("+ column")
    ax_d.set_ylabel("neuron #")
    ax_d.tick_params(length=0, labelsize=8)
    for s in ax_d.spines.values():
        s.set_visible(False)
    # Surface-coloured gaps between cells so individual neurons read clearly.
    ax_d.set_xticks(np.arange(0.5, 15), minor=True)
    ax_d.set_yticks(np.arange(0.5, 7), minor=True)
    ax_d.grid(which="minor", color=SURFACE, linewidth=2)
    ax_d.tick_params(which="minor", length=0)
    return fig


def main():
    parser = argparse.ArgumentParser(description="Visualize hidden-layer activations")
    parser.add_argument("images", nargs="*", type=Path, help="image files to visualize")
    parser.add_argument("--index", type=int, nargs="*", default=[],
                        help="MNIST test-set image indices (default: 0 if no images given)")
    parser.add_argument("--checkpoint", type=Path, default=Path("checkpoints/mnist_cnn.npz"))
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA_DIR)
    parser.add_argument("--out-dir", type=Path, default=Path("visualizations"))
    parser.add_argument("--show", action="store_true", help="open each figure in a window")
    args = parser.parse_args()

    if not args.show:
        matplotlib.use("Agg")   # render to files without needing a display
    import matplotlib.pyplot as plt

    model = DigitCNN()
    model.load(args.checkpoint)
    args.out_dir.mkdir(parents=True, exist_ok=True)

    # (title, raw 28x28 uint8 image for display, normalized model input, output file stem)
    jobs = []
    indices = args.index or ([] if args.images else [0])
    if indices:
        from mnist_digits.data import load_mnist
        load_mnist(args.data_dir)   # downloads the files if missing
        raw = _read_idx(args.data_dir / "t10k-images-idx3-ubyte.gz")
        labels = _read_idx(args.data_dir / "t10k-labels-idx1-ubyte.gz")
        for i in indices:
            jobs.append((f"MNIST test image #{i} (true label {labels[i]})",
                         raw[i], normalize(raw[i][None]), f"test{i}_label{labels[i]}"))
    if args.images:
        from predict import load_image
        for path in args.images:
            x = load_image(path)
            # Undo normalization to show the preprocessed 28x28 the model actually sees.
            from mnist_digits.data import MNIST_MEAN, MNIST_STD
            shown = np.clip((x[0, 0] * MNIST_STD + MNIST_MEAN) * 255, 0, 255).astype(np.uint8)
            jobs.append((f"{path.name} (after preprocessing)", shown, x, path.stem))

    for title, shown, x, stem in jobs:
        hidden, probs = model.activations(x)
        fig = make_figure(shown, hidden, probs[0], title)
        out = args.out_dir / f"{stem}_activations.png"
        fig.savefig(out, dpi=110, facecolor=SURFACE)
        print(f"Saved {out}")
        if not args.show:
            plt.close(fig)
    if args.show:
        plt.show()


if __name__ == "__main__":
    main()
