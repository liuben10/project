"""Download and parse MNIST using only the standard library and NumPy."""

import gzip
import hashlib
import struct
import urllib.request
from pathlib import Path

import numpy as np

DEFAULT_DATA_DIR = Path("data/MNIST/raw")

MIRRORS = [
    "https://ossci-datasets.s3.amazonaws.com/mnist/",
    "https://yann.lecun.com/exdb/mnist/",
]

# file name -> expected MD5, so a corrupted or tampered download is rejected
FILES = {
    "train-images-idx3-ubyte.gz": "f68b3c2dcbeaaa9fbdd348bbdeb94873",
    "train-labels-idx1-ubyte.gz": "d53e105ee54ea40749a09fcbcd1e9432",
    "t10k-images-idx3-ubyte.gz": "9fb629c4189551a2d022fa330f9573f3",
    "t10k-labels-idx1-ubyte.gz": "ec29112dd5afa0611ce80d1b7f02629c",
}

# Mean / std of the MNIST training pixels after scaling to [0, 1].
MNIST_MEAN = 0.1307
MNIST_STD = 0.3081


def _md5(path: Path) -> str:
    return hashlib.md5(path.read_bytes()).hexdigest()


def _fetch(name: str, md5: str, data_dir: Path) -> Path:
    path = data_dir / name
    if path.exists() and _md5(path) == md5:
        return path
    data_dir.mkdir(parents=True, exist_ok=True)
    errors = []
    for base in MIRRORS:
        try:
            print(f"Downloading {base}{name}")
            urllib.request.urlretrieve(base + name, path)
        except OSError as e:
            errors.append(f"{base}: {e}")
            continue
        if _md5(path) == md5:
            return path
        errors.append(f"{base}: checksum mismatch")
    path.unlink(missing_ok=True)
    raise RuntimeError(f"Could not download {name}:\n  " + "\n  ".join(errors))


def _read_idx(path: Path) -> np.ndarray:
    """Parse the IDX format: 2 zero bytes, a type byte, a dims byte, then
    big-endian uint32 sizes, then the raw uint8 data."""
    with gzip.open(path, "rb") as f:
        raw = f.read()
    _, dtype_code, ndim = struct.unpack(">HBB", raw[:4])
    if dtype_code != 0x08:
        raise ValueError(f"{path}: expected uint8 data, got type 0x{dtype_code:02x}")
    dims = struct.unpack(">" + "I" * ndim, raw[4:4 + 4 * ndim])
    return np.frombuffer(raw, dtype=np.uint8, offset=4 + 4 * ndim).reshape(dims)


def normalize(images_uint8: np.ndarray) -> np.ndarray:
    """uint8 [N, 28, 28] in 0..255 -> float32 [N, 1, 28, 28], zero-mean / unit-std."""
    x = images_uint8.astype(np.float32) / 255.0
    return ((x - MNIST_MEAN) / MNIST_STD)[:, None, :, :]


def load_mnist(data_dir: Path = DEFAULT_DATA_DIR):
    """Return (x_train, y_train, x_test, y_test); downloads the files if missing."""
    data_dir = Path(data_dir)
    paths = {name: _fetch(name, md5, data_dir) for name, md5 in FILES.items()}
    x_train = normalize(_read_idx(paths["train-images-idx3-ubyte.gz"]))
    y_train = _read_idx(paths["train-labels-idx1-ubyte.gz"]).astype(np.int64)
    x_test = normalize(_read_idx(paths["t10k-images-idx3-ubyte.gz"]))
    y_test = _read_idx(paths["t10k-labels-idx1-ubyte.gz"]).astype(np.int64)
    return x_train, y_train, x_test, y_test
