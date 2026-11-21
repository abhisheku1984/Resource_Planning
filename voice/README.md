# Offline speech files

On Windows, **`start-windows.bat`** prepares voice before opening the app. `voice:prepare` checks the local runtimes and verifies already-downloaded model sizes and SHA-256s. It installs only missing/invalid microphone files and the Standard speaker for languages without Studio. A Studio-only install needs about 82 MB of mic models, plus the small baseline runtime if missing. Ready installations work offline; no npm reinstall, prompt or extra launcher is needed. `--no-voice` skips the startup preflight. A failure prints the cause and does not prevent the app from starting. No web request can run this installer.

## Explicit manual setup

`npm run voice:setup` is an operator-initiated download, not a server endpoint. It installs the pinned NPM packages here and verifies the four model files in `.cache/models/` against their byte lengths and SHA-256 digests in `assets.js`. No model or generated audio belongs in Git. `-- en` or `-- hi` after the npm command installs just that language. A failed download is not served; rerunning checks existing files before downloading again. Do not substitute an arbitrary model, a ZIP renamed to `.tar.gz`, or a language tag as a voice.

| File | Origin / license | Used for |
|---|---|---|
| `vosk-small-en-in-0.4.tar.gz` | [Alpha Cephei's small Indian English model](https://github.com/alphacep/vosk-space/blob/master/models.md), Apache-2.0. [Browser-format archive](https://github.com/ccoreilly/vosk-browser/tree/a4b0d0fe60359e5ea9800f810f6b6f6c1d2b03c6/models). | Indian English recognition |
| `vosk-small-hi-0.22.tar.gz` | [Alpha Cephei's small Hindi model](https://github.com/alphacep/vosk-space/blob/master/models.md), Apache-2.0. [Pinned model-only tree](https://github.com/factfilter0-coder/vosk-model-hindi/tree/4431efa5f66d086e3aec5c2634f988e2b55d147d); the tarball has the single top-level directory the browser worker strips. | Hindi recognition |
| `cmu-us-ksp-2014.flitevox` | [CMU Flite voice archive](https://github.com/associationconsonne/FliteVoices/tree/33ee8bae1d057ccc2e206912ca401f9ba3a69808), `eng-IND-male;ksp`. Metadata in the voice itself: **variant Indian**, `cmu_us_ksp`; copyright 2005–2014 Carnegie Mellon University. | Spoken Indian English, not a renamed US voice |
| `cmu-indic-hin-ab-2017.flitevox` | Same archive, `hin-IND-female;ab`. CMU Indic Hindi voice; copyright 2009–2017 Carnegie Mellon University. | Spoken Hindi from Unicode text |

The unmodified `.flitevox` files include their CMU permission notices and disclaimers. The [Apache-2.0 license](https://www.apache.org/licenses/LICENSE-2.0) applies to the Vosk models. Engine packages are installed, not vendored: [`@lichess-org/vosk-browser`](https://github.com/lichess-org/vosk-browser) (Apache-2.0), [`@echogarden/flite-wasi`](https://github.com/echogarden-project/flite-wasi) (CMU/BSD-style, see `COPYING`), and [`@bjorn3/browser_wasi_shim`](https://github.com/bjorn3/browser_wasi_shim) (MIT or Apache-2.0). Retain the associated notices if copying an installation.

## Studio speaker upgrade (independent of the above)

`npm run voice:studio` (Windows: `npm.cmd run voice:studio` or `install-studio-voices-windows.bat`, no confirmation prompt) installs the separate `studio/package-lock.json` with scripts disabled, plus the two checksummed **Ninada v5.1.2 VITS/HiFi-GAN** studio models. `-- en` / `-- hi` limits the model download. The model files are 29.3 MB each; including the runtime, both languages cost about 100 MB of downloads. No changes to recognition, root dependencies, SQLite or the Standard installation. [Origins, data credits and licenses](studio/NOTICE.md).

- `ninada-5.1.2-en-IN.onnx`: native Indian English specialist. `ninada-5.1.2-hi-IN.onnx`: native Hindi specialist. Both produce 24,000 Hz mono floating-point audio. Text is normalized **for speech only**; for example, Hindi renders `Giga One में 5 कर्मचारी` as `गिगा वन में पाँच कर्मचारी`. Check the written answer for exact spelling of names/IDs.
- The speaker worker loads only the selected local engine. Studio uses the package tokenizer and a single-thread, WASM-only ONNX Runtime session, not an upstream loader, GPU, CDN, hosted synthesis or remote fallback. It prepares up to one bounded phrase ahead. Stop terminates inference as well as any queued/playing audio.
- Both local packs level each phrase using active-frame RMS (bounded automatic gain, soft peak limiter below −1 dBFS and short edge fades). The volume slider applies to the next utterance: 100% is the leveled signal; 200% boosts it **before** peak limiting. This cannot turn up a muted tab, Windows mixer, or physical speaker. Native `localService` voices use utterance volume 0–1 instead.
- **Auto** tries Studio, then Standard, then a matching local device voice. If Studio cannot start, Auto can try an alternative; it won't repeat a partially played answer. Explicit Studio/Standard selections report missing files or playback errors. Test the two choices on the user's actual device to judge tone and latency.

At runtime only fixed GET/HEAD assets under `/speech/` are served. `/speech/status` reports available `input`, `output` (Standard) and `studio` per language. Vosk uses the origin's IndexedDB to cache **model data**, not speech. Flite uses a private in-memory WASI filesystem. Closing/stopping voice releases the microphone, workers and audio contexts. To uninstall just Studio, remove `voice/studio/node_modules` and the two `ninada-*.onnx` files in `voice/.cache/models`. To remove all downloaded packs, also remove `voice/.cache/models` and `voice/node_modules`; clearing site storage removes the browser model cache (and signs you out). Leave the application's `data/` folder alone.

## Reproduce the browser speech check (optional, for maintainers)

With the main app dependencies and both language packs installed, from the repository root:

```powershell
npm.cmd ci --prefix voice --include=dev --ignore-scripts
$env:CHROME_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'  # or your Edge executable
npm.cmd run voice:check                  # Standard speaker + Vosk in both languages
npm.cmd run voice:check -- --studio      # after voice:studio: Auto / Studio + Vosk in both languages
```

This starts a temporary loopback server with **in-memory demo data** and launches headless Chromium with native speech APIs disabled. It generates questions using the selected real engine, reports raw/leveled RMS and peak in dBFS, passes the leveled WAV through Chromium's file-backed microphone, and checks the scoped response. The microphone is the first audio action, not warmed up by Test speaker. The check observes actual playback, peak headroom, release during reply/after Stop and standalone speaker testing without any new mic request. These measurements test the app signal, not a laptop's acoustic volume or subjective listening quality. It does **not** test physical hardware or require a browser binary download. The ordinary `npm test` suite requires neither these packs nor a browser.
