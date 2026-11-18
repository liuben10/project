"""Train the NumPy CNN on MNIST.

Usage:
    python train.py                       # default: 5 epochs
    python train.py --epochs 2 --batch-size 128
"""

import argparse
import time
from pathlib import Path

import numpy as np

from mnist_digits.data import DEFAULT_DATA_DIR, load_mnist
from mnist_digits.layers import softmax_cross_entropy
from mnist_digits.model import DigitCNN
from mnist_digits.optim import Adam, cosine_lr


def accuracy(model: DigitCNN, x: np.ndarray, y: np.ndarray) -> tuple[float, float]:
    """(mean loss, accuracy) on a dataset, evaluated in batches without dropout."""
    probs = model.predict_proba(x)
    loss = -np.log(probs[np.arange(len(y)), y] + 1e-12).mean()
    return float(loss), float((probs.argmax(axis=1) == y).mean())


def main():
    parser = argparse.ArgumentParser(description="Train a NumPy digit classifier on MNIST")
    parser.add_argument("--epochs", type=int, default=5)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--lr", type=float, default=2e-3, help="peak learning rate")
    parser.add_argument("--weight-decay", type=float, default=1e-4)
    parser.add_argument("--val-size", type=int, default=5000)
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA_DIR)
    parser.add_argument("--out", type=Path, default=Path("checkpoints/mnist_cnn.npz"))
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    rng = np.random.default_rng(args.seed)
    x_all, y_all, x_test, y_test = load_mnist(args.data_dir)

    # Hold out part of the training set to pick the best epoch.
    perm = rng.permutation(len(x_all))
    val_idx, train_idx = perm[:args.val_size], perm[args.val_size:]
    x_train, y_train = x_all[train_idx], y_all[train_idx]
    x_val, y_val = x_all[val_idx], y_all[val_idx]
    print(f"train {len(x_train)} | val {len(x_val)} | test {len(x_test)}")

    model = DigitCNN(seed=args.seed)
    print(f"Model has {model.num_params():,} parameters")
    optimizer = Adam(model, lr=args.lr, weight_decay=args.weight_decay)

    steps_per_epoch = -(-len(x_train) // args.batch_size)   # ceiling division
    total_steps = args.epochs * steps_per_epoch
    step = 0

    args.out.parent.mkdir(parents=True, exist_ok=True)
    best_val_acc = 0.0
    for epoch in range(1, args.epochs + 1):
        start = time.time()
        order = rng.permutation(len(x_train))
        loss_sum, correct, seen = 0.0, 0, 0
        for b in range(steps_per_epoch):
            idx = order[b * args.batch_size:(b + 1) * args.batch_size]
            xb, yb = x_train[idx], y_train[idx]

            logits = model.forward(xb, training=True)            # 1. predict
            loss, dlogits = softmax_cross_entropy(logits, yb)    # 2. measure error
            model.backward(dlogits)                              # 3. backpropagate
            optimizer.step(cosine_lr(step, total_steps, args.lr, warmup_steps=200))  # 4. update
            step += 1

            loss_sum += loss * len(yb)
            correct += int((logits.argmax(axis=1) == yb).sum())
            seen += len(yb)
            if b % 50 == 0:
                print(f"\r  epoch {epoch} batch {b}/{steps_per_epoch} "
                      f"loss {loss_sum / seen:.4f} acc {correct / seen:.4f}", end="", flush=True)

        val_loss, val_acc = accuracy(model, x_val, y_val)
        print(
            f"\rEpoch {epoch:2d}/{args.epochs} | "
            f"train loss {loss_sum / seen:.4f} acc {correct / seen:.4f} | "
            f"val loss {val_loss:.4f} acc {val_acc:.4f} | {time.time() - start:.1f}s"
        )
        if val_acc > best_val_acc:
            best_val_acc = val_acc
            model.save(args.out, val_acc=val_acc, epoch=epoch)

    # Score the best checkpoint on the held-out test set.
    model.load(args.out)
    test_loss, test_acc = accuracy(model, x_test, y_test)
    print(f"Best val acc {best_val_acc:.4f} | Test loss {test_loss:.4f} acc {test_acc:.4f}")
    print(f"Saved model to {args.out}")


if __name__ == "__main__":
    main()
