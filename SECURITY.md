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
| Any third-party scripts, CDNs, web fonts? | None. Fonts are bundled locally. |
| Can other people on my Wi-Fi see it? | No, by default. The server binds to `127.0.0.1` only. |
| What needs internet? | `npm install` once (downloads the two libraries). Nothing after that. |
| Where is the actual data? | One file: `data/resource_planning.db` |

---

## 2. What gets installed

`npm install` downloads **242 packages / 53 MB** into `node_modules`. That sounds
alarming, so here is what it really is:

* **2 direct dependencies** — Express (HTTP routing) and ExcelJS (reads/writes
  `.xlsx`). These are the only libraries this project asked for.
* **240 transitive packages** — the dependencies of those two, and of their
  dependencies. They are ordinary JavaScript utility libraries.

Two facts worth knowing:

* **No package executes code at install time.** I checked every
  `preinstall` / `install` / `postinstall` hook in the tree: there are none. This
  matters because install-time scripts are how most npm supply-chain attacks
  work. (There are `prepublish` entries, but those only run when a package
  author publishes it, never on your machine.)
* **Lockfile pinned.** `package-lock.json` is committed, so `npm install`
  installs exact, reviewed versions rather than "whatever is newest today". For
  a stricter guarantee use `npm ci` (installs the lockfile byte-for-byte).

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
| `exports/hr-master-12000.xlsx` | Generated sample workbook (demo generator only) | Yes |
| `node_modules/` | Libraries | No |

Nothing is written outside the project folder. No temp files with data, no
`AppData` writes, no registry changes, no Windows services, no scheduled tasks.

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

Every response carries a CSP that only permits same-origin content:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; font-src 'self'; connect-src 'self';
form-action 'self'; frame-ancestors 'self'; base-uri 'none'; object-src 'none'
```

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
* **Per-project rights** — `can_edit`, `can_export`, `can_crm` can differ per
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
5. **No automatic backups.** Copy `data/` to an encrypted drive on a schedule.
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
