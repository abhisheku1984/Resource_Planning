# Optional offline speech files

`npm run voice:setup` is an operator-initiated download, not a server endpoint. It installs the pinned NPM packages here and verifies the four model files in `.cache/models/` against their byte lengths and SHA-256 digests in `assets.js`. No model or generated audio belongs in Git. `-- en` or `-- hi` after the npm command installs just that language. A failed download is not served; rerunning checks existing files before downloading again. Do not substitute an arbitrary model, a ZIP renamed to `.tar.gz`, or a language tag as a voice.

| File | Origin / license | Used for |
|---|---|---|
| `vosk-small-en-in-0.4.tar.gz` | [Alpha Cephei's small Indian English model](https://github.com/alphacep/vosk-space/blob/master/models.md), Apache-2.0. [Browser-format archive](https://github.com/ccoreilly/vosk-browser/tree/a4b0d0fe60359e5ea9800f810f6b6f6c1d2b03c6/models). | Indian English recognition |
| `vosk-small-hi-0.22.tar.gz` | [Alpha Cephei's small Hindi model](https://github.com/alphacep/vosk-space/blob/master/models.md), Apache-2.0. [Pinned model-only tree](https://github.com/factfilter0-coder/vosk-model-hindi/tree/4431efa5f66d086e3aec5c2634f988e2b55d147d); the tarball has the single top-level directory the browser worker strips. | Hindi recognition |
| `cmu-us-ksp-2014.flitevox` | [CMU Flite voice archive](https://github.com/associationconsonne/FliteVoices/tree/33ee8bae1d057ccc2e206912ca401f9ba3a69808), `eng-IND-male;ksp`. Metadata in the voice itself: **variant Indian**, `cmu_us_ksp`; copyright 2005–2014 Carnegie Mellon University. | Spoken Indian English, not a renamed US voice |
| `cmu-indic-hin-ab-2017.flitevox` | Same archive, `hin-IND-female;ab`. CMU Indic Hindi voice; copyright 2009–2017 Carnegie Mellon University. | Spoken Hindi from Unicode text |

The unmodified `.flitevox` files include their CMU permission notices and disclaimers. The [Apache-2.0 license](https://www.apache.org/licenses/LICENSE-2.0) applies to the Vosk models. Engine packages are installed, not vendored: [`@lichess-org/vosk-browser`](https://github.com/lichess-org/vosk-browser) (Apache-2.0), [`@echogarden/flite-wasi`](https://github.com/echogarden-project/flite-wasi) (CMU/BSD-style, see `COPYING`), and [`@bjorn3/browser_wasi_shim`](https://github.com/bjorn3/browser_wasi_shim) (MIT or Apache-2.0). Retain the associated notices if copying an installation.

At runtime only fixed GET/HEAD assets under `/speech/` are served. The Vosk worker uses the origin's IndexedDB to cache **model data**, not speech. The speaker uses a private in-memory WASI filesystem. Closing/stopping voice releases the microphone, workers and audio contexts. To remove downloaded packs, stop the app and remove `voice/.cache/models` and `voice/node_modules`; clearing site storage removes the browser model cache (and signs you out). Leave the application's `data/` folder alone.

## Reproduce the browser speech check (optional, for maintainers)

With the main app dependencies and both language packs installed, from the repository root:

```powershell
npm.cmd ci --prefix voice --include=dev --ignore-scripts
$env:CHROME_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'  # or your Edge executable
npm.cmd run voice:check
```

This starts a temporary loopback server with **in-memory demo data** and launches headless Chromium with native speech APIs disabled. It generates WAV questions using each actual voice, passes them through Chromium's file-backed microphone, checks the scoped response, and checks that real audio tracks are ended during the spoken reply and after Stop. It does **not** test physical hardware or require a browser binary download. The ordinary `npm test` suite requires neither these packs nor a browser.
