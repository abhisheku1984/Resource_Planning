# GitHub Pages runtime

`docs/` is the static distribution of the **same UI** as `public/`. Visitors land in the dashboard as a sample administrator. Navigation uses URL hashes. There is no sign-in, live HTTP API, GitHub token, service worker, shared database or third-party service. Selecting a sample persona demonstrates scoped views, not authentication. Closing or reloading the tab discards all workforce changes.

- `scripts/build-pages.js` bundles the same UI and route handlers using explicit build-time adapters. The Windows server does **not** serve `docs/` or load its adapters. Both publishing locations (`main:/` and `main:/docs`) have an entry point; the Jekyll default-deny allowlist is only for the root source. Never add a **root** `.nojekyll`, which would bypass this filter.
- `scripts/pages-fixture.js` opens only a newly created `:memory:` database to generate **reference settings** from the built-in seed. The account projection contains names/roles, never hashes or sessions. All initial workforce values come from the hard-coded, SHA-256-checked `samples/workforce-1000.xlsx`; the workbook itself isn't a Pages asset. `sample.gz` contains those synthetic columns and reference settings, not an SQLite file or backup.
- `transport.js` dispatches app requests via `postMessage` (including downloads). `engine.js` serializes them on a dedicated worker with sql.js. `router.js` runs the same registered handlers, grants and validators as the private app. Only sample personas can be selected; credential routes are unavailable. `platform.js` loads the self-hosted ExcelJS browser distribution only when a workbook is needed. It accepts only the pinned sample or an exact workbook produced in this tab (last 32); no workbook or edit is transmitted. On the private Node server, password sessions, streaming, disk restore points and arbitrary authorized workforce imports work as before.
- `docs/index.html` is the entry template. The root entry uses the same assets under `./docs/`, so links and reloads work under `/Resource_Planning/`. `site.css` here adds only the sample notice/loading state to the shared app CSS. Fonts and third-party license notices are self-hosted.

Build after changing shared app code (`Node 22`, from the repo root):

```sh
npm ci
npm run build:pages
npm test                 # includes a clean-build comparison and static allowlist checks
npm run test:pages-browser  # set CHROMIUM_PATH to an installed Chromium executable
```

Commit the regenerated files with the source: branch-based Pages does not run npm. The browser test serves **only** the static payload in both project-site layouts and fails on outbound navigation/API calls. It edits a fictional record and tests a sample replacement in memory, never against a running installation. Production uploads and shared supervisor edits must remain in the approved private installation.
