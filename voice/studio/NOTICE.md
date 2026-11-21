# Studio voice attributions

The optional `voice:studio` command downloads two **unmodified** Ninada v5.1.2 ONNX models from the fixed Git blobs in `../assets.js`. Neither model, the donors nor any training recordings are included in this repository. Retain this notice with an installed copy.

- **Models and tokenizer:** [Ninada, Hemanth HM](https://github.com/hemanth/ninada/tree/745b55633615cfacc636af81ac08450fd3ff35d3). The [manifest](https://github.com/hemanth/ninada/blob/745b55633615cfacc636af81ac08450fd3ff35d3/docs/models_manifest.json) identifies the studio graphs. The publisher's [model card source](https://github.com/hemanth/ninada/blob/745b55633615cfacc636af81ac08450fd3ff35d3/training/publish_hf.py) declares MIT for the model release. The tokenizer package includes the Ninada MIT license.
- **Donor models:** [SYSPIN, SPIRE Lab, Indian Institute of Science](https://github.com/labspire/Syspin), `SYSPIN/vits_English_Male` and `SYSPIN/vits_Hindi_Male`. See the [upstream training recipe](https://github.com/hemanth/ninada/blob/745b55633615cfacc636af81ac08450fd3ff35d3/training/train_native_specialists_gcp.py).
- **Indian English training corpus:** [IndicTTS-English, SPRINGLab / IIT Madras](https://huggingface.co/datasets/SPRINGLab/IndicTTS-English). Ninada's dataset card credits this corpus under CC BY 4.0.
- **Hindi training corpus:** [AI4Bharat Rasa](https://huggingface.co/datasets/ai4bharat/Rasa). Praveen Srinivasa Varadhan, Ashwin Sankar, Giri Raju and Mitesh M. Khapra, *Rasa: Building Expressive Speech Synthesis Systems for Indian Languages in Low-resource Settings*, INTERSPEECH 2024. [Project credit and license](https://github.com/AI4Bharat/Rasa#license): [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- **Inference runtime:** ONNX Runtime Web, Copyright (c) Microsoft Corporation. All rights reserved. MIT (`onnxruntime-web`, pinned in this folder's lockfile). Only its WASM backend runs here.

These are the publisher's model terms and training-source credits, not an independent license grant for the source corpora, donors or third-party redistribution. Review the respective terms before redistributing a preinstalled bundle. Local playback uses these models for generic synthetic speech; this app neither trains voices nor clones user voices.

### MIT notice

Copyright (c) 2026 Hemanth HM <hemanth@h3manth.com> (https://h3manth.com) — Ninada

Copyright (c) Microsoft Corporation. All rights reserved. — ONNX Runtime

Copyright (c) 2025 Spire Lab — SYSPIN project

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
