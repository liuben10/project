# MNIST Handwritten Digit Classifier (NumPy only)

A small convolutional network written from scratch: no PyTorch, TensorFlow or other ML
libraries. Every layer's forward pass, backpropagation and the Adam optimizer are written
by hand using NumPy arrays and matrix multiplication. Hidden layers use the **sigmoid**
activation.

## Layout

```
mnist-digits/
├── mnist_digits/
│   ├── layers.py  # Conv2D, Sigmoid, MaxPool2D, Flatten, Dense, Dropout, softmax cross-entropy
│   ├── model.py   # DigitCNN: stacks the layers, runs forward/backward, saves/loads weights
│   ├── optim.py   # Adam optimizer + cosine learning-rate schedule
│   └── data.py    # downloads and parses the raw MNIST files (IDX format)
├── train.py       # training loop, saves the best checkpoint
├── predict.py     # classify your own digit images
├── visualize.py   # heatmaps of every hidden layer's activations
├── gradcheck.py   # verifies backprop against numerical derivatives
├── export_web_data.py  # packs an MNIST subset into web/mnist-data.js
├── deploy.py      # builds web/ and publishes it to AWS (S3 + CloudFront)
├── web/           # interactive "Inside a Neural Network" page (see below)
│   ├── index.html, style.css
│   ├── nn.js      # fully-connected network + 5 activation functions, in plain JavaScript
│   ├── viz.js     # network diagram, accuracy chart, activation plot
│   ├── explain.js # explainer widgets: one-neuron playground, layer shapes, loss plot
│   ├── app.js     # training loop, image slider, sketch pad
│   └── mnist-data.js  # generated: 10,000 train + 2,000 test images (gzip + base64)
└── requirements.txt
```

## Model

```
Input [N, 1, 28, 28]
  Conv(1→16, 3×3)  + Sigmoid + MaxPool 2×2   → [N, 16, 14, 14]
  Conv(16→32, 3×3) + Sigmoid + MaxPool 2×2   → [N, 32, 7, 7]
  Flatten                                     → [N, 1568]
  Dense(1568→128)  + Sigmoid + Dropout 0.25   → [N, 128]
  Dense(128→10)                               → [N, 10] scores, one per digit
```

Convolutions use **im2col**: every 3×3 patch is unrolled into a row so the whole convolution
is one matrix multiplication, `patches @ filters.T`.

## Setup

```bash
python -m venv .venv
.venv\Scripts\activate        # Windows  (source .venv/bin/activate on macOS/Linux)
pip install -r requirements.txt
```

## Train

```bash
python train.py
```

Options: `--epochs`, `--batch-size`, `--lr`, `--weight-decay`, `--data-dir`, `--out`, `--seed`.
MNIST is downloaded to `data/MNIST/raw/` on first run (checksums are verified). The best model
by validation accuracy (5k images held out from the training set) is saved to
`checkpoints/mnist_cnn.npz`, then scored on the 10k test set.

## Predict

```bash
python predict.py my_digit.png
```

Any image size works. Images are converted to grayscale, inverted if dark-on-light, cropped to
the digit and centred in a 28×28 frame to match MNIST.

## Visualize hidden-layer activations

```bash
python visualize.py                  # MNIST test image #0
python visualize.py --index 0 7 42   # several test images
python visualize.py my_digit.png     # your own image
```

Saves one PNG per image to `visualizations/` (add `--show` to open a window). Each shows the
input and prediction, then heatmaps of the 16 conv-1 feature maps, the 32 conv-2 feature maps
and the 128 dense-layer neurons. All hidden layers use sigmoid, so every heatmap shares one
0–1 colour scale: light means a neuron is barely firing, dark blue means firing strongly.

## Interactive web page

Open `web/index.html` in a browser (double-click it; no server or install needed). It walks
through deep learning in three steps:

1. **Build the network.** Starts with an explainer:
   - a timeline of the artificial neuron, from McCulloch and Pitts (1943) and the perceptron to
     backpropagation, MNIST and deep learning
   - a one-neuron playground with sliders for inputs, weights and bias, including the
     perceptron's original step function
   - how a layer becomes a matrix multiplication `z = Wx + b`, with a worked example and the
     matrix shapes for the network you choose
   - softmax and cross-entropy loss, with an interactive loss curve
   - gradient descent and why the activation function's slope matters

   Then pick an activation function (sigmoid, tanh, ReLU, leaky ReLU or none) and a layer size.
2. **Watch it learn.** Train in the browser at 1 image per second up to about 20,000 per second.
   The network diagram colors each neuron by how strongly it fires and each connection by the
   signal it carries. A slider browses the 10,000 training images; hover over any neuron to see
   its value, and for first-layer neurons the image its 784 weights have learned.
3. **Try it yourself.** Draw a digit and watch the same network classify it, with the activated
   neurons shown in the same diagram.

The page trains its own fully-connected network in JavaScript (about 93–94% test accuracy after
a few epochs); it doesn't use the Python CNN's checkpoint. To include more images, regenerate
the data file:

```bash
python export_web_data.py --train 20000 --test 2000
```

### Deploying the page

Live at **https://d2ope19ru4i9ms.cloudfront.net/**.

```bash
AWS_PROFILE=personal python deploy.py
```

In PowerShell:

```powershell
$env:AWS_PROFILE = "personal"; .venv\Scripts\python deploy.py
```

Publishes the page with the AWS CLI (v2). Use the `personal` profile: the `default` profile's
account belongs to an AWS Organization whose policy blocks creating buckets and using
CloudFormation. The script creates resources with direct CLI calls. Every step is
idempotent, so rerunning it reuses what already exists:

- a private S3 bucket `inside-a-neural-network-<account id>` with public access blocked,
  encryption, versioning (old versions expire after 30 days), and HTTPS-only access
- a CloudFront distribution with HTTPS, HTTP/2 and HTTP/3, and compression; it's the only
  thing allowed to read the bucket
- a security-headers policy: Content-Security-Policy, HSTS, no framing, `nosniff`

Each deploy builds `build/web/` with content-hashed asset names, cached for a year, and
uploads `index.html` last, revalidated on every visit, so updates appear immediately.
`--prune` removes files from older deploys, and `--build-only` skips AWS.

The page must keep working under the Content-Security-Policy: no inline `<script>`,
no `style="…"` attributes and no `eval`. The policy allows `data:` images, which the
neuron tooltips use.

## Check the gradients

```bash
python gradcheck.py
```

Nudges individual weights up and down, measures how the loss changes, and confirms that matches
the gradients computed by backpropagation.
