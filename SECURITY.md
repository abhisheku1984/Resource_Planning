# Data safety guide

Written to answer one question: *if I run this on my laptop with my real HR
data, what does it touch, what does it send, and who can see it?*

Everything below was verified against the code in this repository, not assumed.

---

## 1. Summary

| Question | Answer |
| --- | --- |
| Does my data leave my computer? | **No.** Not at runtime, not ever, once installed. |
| Is there a cloud database? | No. A single SQLite file on your disk. |
| Any analytics, telemetry, crash reporting? | None. |
| Any scripts or fonts loaded from a third-party site? | No. The application code and fonts are served locally. |
| Can other people on my Wi-Fi see it? | No, by default. The server binds to `127.0.0.1` only. |
| What needs internet? | Installing npm dependencies for the first time. Normal operation, including typed Ask, needs no internet. |
| Where is the actual data? | One file: `data/resource_planning.db` |

---

## 2. What gets installed

The runtime uses **two direct dependencies**: Express for HTTP routing and ExcelJS for `.xlsx` files. Their transitive dependencies install into `node_modules`. The Windows launchers use `npm ci --omit=dev --ignore-scripts` on first use. Playwright Core is a development dependency for the optional browser check, not an application runtime or a browser download.

Two facts worth knowing:

* The Windows launchers disable dependency install scripts. The application does not need a native compilation step.
* The committed lockfile pins package versions and integrity hashes; `npm ci` installs from that file rather than updating it.

### The one audit finding, explained honestly

`npm audit` reports **2 moderate** advisories, both the same root cause: an old
`uuid` version inside ExcelJS has a missing bounds check *when you pass a buffer
to `uuid.v3/v5/v6`*. This application never imports `uuid` and never calls it,
so that code path is unreachable here. The suggested "fix" downgrades ExcelJS
from 4.x to 3.x, which is a breaking change — deliberately not applied. It is
worth re-checking with `npm audit` before each release.

---

## 3. What the application touches on your disk

| Path | What it is | Sensitive? |
| --- | --- | --- |
| `data/resource_planning.db` | **All employee data** — one SQLite file | **Yes** |
| `data/resource_planning.db-wal` | Write-ahead log, same data, transient | **Yes** |
| `data/resource_planning.db-shm` | Shared-memory index file, transient | Yes |
| `roster-backups/<database>.before-last-replace.db` next to the active DB | Latest admin-initiated full-roster replacement restore point (includes credentials/hashes, sessions and history); never served as a download | **Yes** |
| `exports/hr-master-12000.xlsx` | Generated sample workbook (demo generator only) | Yes |
| `node_modules/` | Libraries | No |

The server keeps app files in the project folder; there are no registry changes, Windows services or scheduled tasks. The browser maintains its usual profile and site storage. Any model caches left on a machine by an older release are not used or served.

To move or back up the whole installation: copy the project folder. To move only
the data: copy `data/resource_planning.db` (stop the server first so the WAL is
flushed — or copy all three `resource_planning.db*` files).

---

## 4. Network behaviour, precisely

**At runtime the server makes zero outbound connections.** There is no code path
that calls out to the internet. It only listens on a socket.

The *browser* also makes no external requests. This was previously not quite
true — the UI loaded the Inter font from Google Fonts, which would have leaked
the fact that someone used the app (and their IP) to a third party. That has
been fixed: the font files are now vendored in `public/fonts/` (100 KB, SIL Open
Font License) and served from the app itself. Verified: the served HTML contains
**zero** `https://` references.

Ask sends typed messages to the local app server. It does not request microphone permission, record audio, synthesize speech, or download language models.

### Binding address — the most important setting

Default: `HOST=127.0.0.1` → **only this computer can connect**. Your colleague
on the same Wi-Fi cannot open the app, even if they know the port.

To share it deliberately on a trusted network:

```powershell
$env:HOST="0.0.0.0"; npm start
```

or run `start-windows.bat --lan`. The launcher prints a visible warning when you
do this. Only use it on a network you trust, because at that point the app's own
login is the only thing protecting the data.

### Content-Security-Policy

The app page and ordinary resources carry the following CSP. The hosted preview
(`ARENA_PREVIEW=1`) additionally allows Arena to frame the app; the Windows
start commands do not enable this exception.

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; font-src 'self'; connect-src 'self';
form-action 'self'; frame-ancestors 'self'; base-uri 'none'; object-src 'none'
```

There are no worker-specific evaluation exceptions. The server also sends `Permissions-Policy: microphone=()` so the document cannot access a microphone.

Practical effect: even if malicious content ended up in a field, it could not
load a remote script, phone home, or exfiltrate data to another domain. Also set:
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`X-Permitted-Cross-Domain-Policies: none`.

---

## 5. How the app protects the data itself

These are the controls actually implemented (each has a test):

* **Passwords** are hashed with `scrypt` (64-byte digest, per-user random salt)
  and compared in constant time. Plaintext passwords are never stored.
* **Sessions** are 32-byte random tokens with a 7-day expiry, stored
  server-side; changing your password invalidates all sessions.
* **Authorization is server-side.** Every read and write re-checks the caller's
  project grant. Hiding a button in the browser is never the protection — the API
  returns `403` regardless. Tests assert this for each verb on a foreign project.
* **Giga-scoped accounts** — one workbook Giga Project Name replaces hierarchy
  grants. SQL checks the current assignment value before listing, counting,
  editing or exporting it; names are bound values, not `LIKE` patterns. A blank
  grant authorizes no rows. Access is reloaded on each authenticated request.
  Master imports and global configuration are unavailable to these accounts.
* **Hierarchy-based accounts** — `can_edit`, `can_export`, `can_crm` can differ per
  person per project. A read-only reviewer cannot write, even with a crafted request.
* **SQL injection** is not possible in the normal path: every query uses bound
  parameters. Sort column names are whitelisted rather than interpolated.
* **Audit trail.** Every field change is appended to `audit_log` with who, when,
  old value and new value. It is append-only from the app's perspective.
* **Concurrency safety.** Writes run in `BEGIN IMMEDIATE` transactions;
  conflicting edits return `409` instead of silently overwriting someone else.
* **Upload limits.** JSON bodies are capped at 40 MB, so a huge upload cannot
  exhaust memory.
* **Import protection.** A value a supervisor edited by hand is marked protected;
  a later HR re-upload reports it as skipped rather than clobbering it.

---

## 5a. The in-app assistant

The assistant raises an obvious question — "does this thing send our data
somewhere?" Answer: **no.** Intent and field matching run in the app (Node and the browser tab), not in a cloud service.

| Concern | Reality |
|---|---|
| Does it call an AI provider? | No. There is no API key, no SDK, no HTTP client for it. `server/agent.js` is plain string matching plus SQL against the local database. |
| Does it use the microphone or play replies aloud? | No. Ask accepts text and displays replies, tables and CRM drafts. |
| What is remembered when I switch languages? | Ask stores its language preference in browser local storage, not chat messages or CRM drafts. An open draft stays in memory and must be reviewed again before confirmation. |
| Can it change records on its own? | No. Bench/block requests in general Ask are proposals for administrator approval. A guided employee update fills an authenticated CRM form. Its review route returns a server-validated before/after diff, not a write. Only a separate confirmation uses the employee edit transaction and audit trail. The ordinary Update panel retains its existing autosave behavior. |
| Can it leak another project's data? | The assistant resolves only Giga Project Names from active placements in the caller’s access. Counts, lists, proposals and CRM all intersect the exact workbook name with assignment ACLs. A missing or ambiguous name never enables a broader search. CRM submit rechecks the placement, CRM/edit grants, editable fields and revision. |
| Does it weaken the audit trail? | Proposals and approvals are logged with the requester and approver. Confirmed guided edits log the authenticated editor, field, old/new values and the reason `Confirmed guided CRM update`. The review does not log draft values as edits. |
| What if it mis-parses? | The damage is bounded: a wrong proposal needs a human to approve it, and approval is refused if the target field or workbook project changed (`stale`). In the CRM form a draft value must be reviewed and separately confirmed by the editor. |

A guided review is bound to the session, exact Giga project, employee/placement,
revision and canonical field diff. The server keeps only digests and an expiry
in a bounded in-memory map (latest ticket per session, five minutes, single
use). Tokens are not put in browser storage. Editing the draft, switching
language, hiding the tab or closing Ask drops the browser's confirmation;
starting another review supersedes the previous ticket on the server. Confirm
checks the current scope, form layout, values and revision again. Restarting
the server invalidates outstanding reviews. This is a safeguard for the guided
workflow, not a restriction on independently authorized manual edit endpoints.

One honest limitation: because it is pattern matching, it will not understand
unusual phrasing. It says so plainly ("I did not understand that yet") instead of
guessing. Adding a real language model later would mean accepting outbound calls
and an API key — that trade is deliberately *not* made here.

## 6. Known limitations — read before using real data

I would rather you know these than discover them later.

1. **No HTTPS.** Traffic between browser and server is plain HTTP on loopback.
   That is acceptable on one machine (`127.0.0.1` never leaves the host). It is
   **not** acceptable if you expose the app on a LAN — add a reverse proxy with
   TLS (e.g. Caddy or nginx) before doing that.
2. **Demo accounts ship with known passwords** and the login screen lists them.
   Before real use: delete the seeded users, create your own accounts, and remove
   the demo panel from `public/js/views/login.js`.
3. **The SQLite file is not encrypted at rest.** Anyone with file access (or the
   laptop in the wrong hands) can read it. Use full-disk encryption — BitLocker
   on Windows — and keep the project folder out of OneDrive/Dropbox sync, which
   would upload your database to a third-party cloud.
4. **No rate limiting on login.** Someone who can reach the port can attempt many
   passwords. Another reason to keep the loopback binding.
5. **No scheduled backups.** A confirmed full-roster replacement saves one private SQLite restore point before deletion. This does not replace scheduled, tested backups on encrypted storage; archive dated workforce exports privately.
6. **The database holds PII** (names, emails, phone numbers, salary/rate data).
   Depending on your jurisdiction this may be regulated; treat the file as
   confidential and define who may copy it.

---

## 7. Pre-flight checklist for real data

- [ ] Server bound to `127.0.0.1` (the default)
- [ ] Seeded demo users deleted; your own admin account created
- [ ] Demo credentials panel removed from the login page
- [ ] BitLocker (or equivalent) enabled on the laptop
- [ ] Project folder **not** inside OneDrive / Dropbox / Google Drive
- [ ] Antivirus exclusion in place only if scans are slowing the database
- [ ] Backup routine for `data/` on an encrypted drive
- [ ] You have decided whether it may ever listen on `0.0.0.0`
- [ ] `npm audit` reviewed before each upgrade

## 8. If you need to go further

For a multi-user deployment you would want, in rough order of value: HTTPS via a
reverse proxy, per-user login rate limiting, encrypted backups, an external
secrets store for the session key, and a security review of the two direct
dependencies. None of that is required to run it safely on one laptop.
