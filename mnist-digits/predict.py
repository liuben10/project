"""Predict the digit in one or more image files using a trained checkpoint.

Usage:
    python predict.py path/to/digit.png [more.png ...]
    python predict.py --checkpoint checkpoints/mnist_cnn.npz my_digit.jpg

Images can be any size/colour. They are converted to 28x28 grayscale. MNIST digits
are white-on-black; dark-on-light images (e.g. pen on paper) are inverted automatically.
Pillow is used only to read image files.
"""

import argparse
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps, ImageStat

from mnist_digits.data import normalize
from mnist_digits.model import DigitCNN


def load_image(path: Path) -> np.ndarray:
    img = Image.open(path).convert("L")
    # If the background is light, invert so the digit is bright on dark like MNIST.
    if ImageStat.Stat(img).mean[0] > 127:
        img = ImageOps.invert(img)
    # Fit the digit into a 20x20 box centred in 28x28, matching MNIST preprocessing.
    bbox = img.point(lambda p: 255 if p > 50 else 0).getbbox()
    if bbox:
        img = img.crop(bbox)
    img.thumbnail((20, 20), Image.LANCZOS)
    canvas = Image.new("L", (28, 28), 0)
    canvas.paste(img, ((28 - img.width) // 2, (28 - img.height) // 2))
    return normalize(np.asarray(canvas, dtype=np.uint8)[None])   # [1, 1, 28, 28]


def main():
    parser = argparse.ArgumentParser(description="Classify handwritten digit images")
    parser.add_argument("images", nargs="+", type=Path)
    parser.add_argument("--checkpoint", type=Path, default=Path("checkpoints/mnist_cnn.npz"))
    args = parser.parse_args()

    model = DigitCNN()
    model.load(args.checkpoint)

    for path in args.images:
        probs = model.predict_proba(load_image(path))[0]
        digit = int(probs.argmax())
        print(f"{path}: {digit} (confidence {probs[digit]:.2%})")


if __name__ == "__main__":
    main()
