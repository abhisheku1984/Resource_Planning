# Resource Planning Platform

Single source of truth for the workforce master: one SQLite database, Excel as
import/export only, supervisors update records in the app.

## Quick start (Node 22.5 or newer — nothing else)

```bash
git clone https://github.com/abhisheku1984/Resource_Planning.git
cd Resource_Planning
git checkout arena/bd816d6f-resource-planning
npm install
npm run demo      # builds the 12,000-employee demo database (about 10 seconds)
npm start         # http://localhost:4000
```

`npm run demo` wipes `data/` and regenerates everything, so re-run it any time you
want a clean dataset. `npm run demo -- --rows 500` makes a smaller one.

### Demo logins

| Role | Email | Password |
|---|---|---|
| Administrator | `admin@resourceplanning.io` | `Admin@12345` |
| Supervisor — NEXUS | `priya.nair@resourceplanning.io` | `Super@12345` |
| Supervisor — ATLAS + HORIZON | `rohit.verma@resourceplanning.io` | `Super@12345` |
| Supervisor — ORBIT | `meera.iyer@resourceplanning.io` | `Super@12345` |
| Supervisor — NEXUS/ATLAS/ORBIT/VERTEX | `sameer.khan@resourceplanning.io` | `Super@12345` |
| Supervisor — VERTEX + ZENITH | `arun.pillai@resourceplanning.io` | `Super@12345` |
| Read-only reviewer | `kavita.rao@resourceplanning.io` | `Super@12345` |
| HR uploader | `hr.upload@resourceplanning.io` | `Hr@1234567` |

Windows: `start-windows.bat` does the install, demo build and start in one step.

### Tests

```bash
npm test          # 28 integration + UI smoke tests
```

## Quick start

> **This is a Node.js application, not a Python one.** There is no `pip`, no
> virtualenv and no `requirements.txt`. The only prerequisite is Node.js 22.5 or
> newer — `node:sqlite` is built into Node, so there is nothing to compile and no
> native modules to install. `package.json` is used only to fetch two pure-JS
> packages (Express and ExcelJS).

```bash
npm install
npm start            # http://localhost:4000  (binds 0.0.0.0)
```

The first run creates `data/resource_planning.db` and seeds a demo dataset
(4 projects, 15 categories, 170 people, 231 placements, 7 users).

```bash
npm run seed         # rebuild the demo dataset from scratch
npm test             # 24 integration + UI tests
```

Environment variables: `PORT`, `HOST`, `DATA_DIR`, `DB_FILE`.

> **Privacy default:** the server binds to `127.0.0.1`, so only this computer can
> reach it. Set `HOST=0.0.0.0` (or run `start-windows.bat --lan`) to share it on a
> trusted network. The app makes **no outbound requests** at runtime — no CDNs, no
> web fonts, no telemetry. See [SECURITY.md](SECURITY.md).

### Windows

1. Install **Node.js 22 LTS or newer** from <https://nodejs.org> — pick the
   Windows Installer (`.msi`) and accept the defaults. Verify in a *new*
   PowerShell or Command Prompt window:

   ```powershell
   node -v      # must print v22.5.0 or higher
   npm -v
   ```

2. Clone and enter the repository (any parent folder works):

   ```powershell
   git clone https://github.com/abhisheku1984/Resource_Planning.git
   cd Resource_Planning
   git checkout arena/bd816d6f-resource-planning
   ```

3. **Double-click `start-windows.bat`.** It checks your Node version, runs
   `npm install` on first launch, starts the server and opens
   <http://localhost:4000> automatically. Keep the console window open while you
   work; press `Ctrl+C` there to stop.

   Or do it manually:

   ```powershell
   npm install
   npm start
   ```

4. Double-click `run-tests.bat` to run the test suite.

Notes for Windows:

* If PowerShell blocks `npm` with a script-execution error, use Command Prompt
  instead, or run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once.
* `data\resource_planning.db` is created on first start — delete that file (or
  run `npm run seed`) to reset the demo data.
* The launcher is a `.bat` file, so no WSL is required. WSL2 works too if you
  prefer a Linux shell.
* Windows Firewall may ask for permission the first time; allow it on private
  networks. For access from another machine on your LAN, open port 4000 (the
  server already binds `0.0.0.0`).

### Demo accounts

| Email | Password | Role |
| --- | --- | --- |
| `admin@resourceplanning.io` | `Admin@12345` | Administrator — all projects |
| `priya.nair@resourceplanning.io` | `Super@12345` | Supervisor — Nexus only |
| `rohit.verma@resourceplanning.io` | `Super@12345` | Supervisor — Atlas only |
| `meera.iyer@resourceplanning.io` | `Super@12345` | Supervisor — Orbit + Vertex |
| `sameer.khan@resourceplanning.io` | `Super@12345` | Supervisor — 3 projects, can import |
| `kavita.rao@resourceplanning.io` | `Super@12345` | Read-only reviewer |
| `arun.pillai@resourceplanning.io` | `Super@12345` | Supervisor — Vertex only |

The sign-in screen lists them; clicking **Use** fills the form.

---

## How the model works

```
projects ──< subprojects ──< categories ──< category_fields >── fields
                     │
employees ──< assignments >── projects / subprojects / categories / suppliers
                     │
                     └──< assignment_values >── fields
                     └──< field_overrides        (protects manual edits)
```

* **A row in the employee table is an assignment** — a person placed in a
  subproject + category, optionally under a supplier. One person can therefore
  appear in several projects without ever being duplicated.
* **Identity lives on `employees`** and is keyed by `emp_code` (the configurable
  business key). Names are never treated as unique.
* **Configured columns** are `fields`; a category opts into a subset via
  `category_fields`, which also stores `visible`, `editable` and `required`.
* **Core fields** (`emp_code`, `name`, `designation`, `email`, `phone`, `status`,
  `supplier`, `remarks`) map onto real columns. Every other field stores its
  value in `assignment_values`, so administrators can invent columns at runtime.

### Configurable hierarchy

Projects, subprojects and categories are ordinary records created in
*Administration → Projects & hierarchy*. Because categories hang off
subprojects (not projects), two projects can have completely different
structures, and two subprojects of the same project can have different category
sets — see the seeded Nexus vs. Atlas trees.

### Dynamic tables

`GET /api/employees?categoryId=…` returns both `rows` and the `columns` that
apply to that category. The client renders whatever it is given, so a category
configured with Training Status + Joining Date + Completion Status looks nothing
like one configured with Billing Status + Allocation Status + Effective Date.
Hidden columns are never serialised, so they cannot leak through the API.

### Embedded CRM

The panel is part of the workspace layout, not a separate screen. It supports
search, add, edit, placement switching and per-field history. Autosave is
debounced (900 ms) and reports `Unsaved → Saving… → Saved`; on failure it shows
`Not saved` with an explicit retry, and the pending values stay in the form.

### Duplicate prevention

Incoming identity data is matched on employee ID (exact), email, phone and name.
A hard match (ID/email/phone with a *different* employee ID) is queued in
`duplicate_reviews` for an administrator instead of being written silently. Name
matches alone are always queued — never auto-merged.

### Excel synchronisation

* `GET /api/export?projectId=&subprojectId=&categoryId=&supplierId=` streams a
  workbook with `Employees` and `Summary` sheets built from the live database.
* `POST /api/import` upserts a daily dataset **by employee ID** inside one
  transaction. Fields a supervisor edited by hand are recorded in
  `field_overrides`; the import reports them as `protected` and leaves them
  alone unless an administrator explicitly forces the override.
* A `dryRun` flag validates a workbook and returns per-row errors without
  writing anything, which is what the Data Hub preview uses.

### Access control

* **Roles** — `admin` (everything) and `supervisor`.
* **Capabilities** — `project.view`, `employee.edit`, `employee.create`,
  `crm.use`, `export.data`, `import.data`, `schema.manage`, `users.manage`,
  `audit.view`.
* **Project grants** — each supervisor has per-project `can_edit`, `can_export`
  and `can_crm` flags.

Every read and write re-checks the grant on the server
(`assertProjectAccess`, `visibleProjectIds`). The UI hides controls as a
courtesy; the API is the enforcement point, and the tests assert 403s for each
verb on foreign projects.

### Concurrency and audit

* Writes run in `BEGIN IMMEDIATE` transactions, so multi-field CRM saves are
  atomic and concurrent supervisors cannot interleave partial updates.
* `PATCH /api/employees/:id` accepts `rev` (the assignment's `updated_at`). A
  stale revision returns `409 STALE` plus the current record, so the client can
  show the conflict instead of silently overwriting.
* Every field change appends to `audit_log` with actor, old value and new value.
  The CRM and the Audit Trail read from it.

---

## API surface

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/login`, `/api/auth/logout` | Session tokens (scrypt hashes) |
| `GET` | `/api/bootstrap` | User, tree, field catalogue, suppliers, totals |
| `GET` | `/api/dashboard` | Aggregates for the dashboard |
| `GET` | `/api/employees` | Dynamic table: scope, search, filter, sort, paginate |
| `GET` | `/api/employees/:id` | One record with its category's columns |
| `PATCH` | `/api/employees/:id` | Validated update with optimistic concurrency |
| `GET` | `/api/employees/:id/history` | Field-level audit history |
| `POST` | `/api/employees` | Create person / link placement (duplicate-aware) |
| `GET` | `/api/people`, `/api/people/:id` | CRM directory search, placements |
| `GET`/`PUT` | `/api/categories/:id/columns` | Read / write the column layout |
| `GET`/`POST`/`PATCH` | `/api/projects`, `/api/subprojects`, `/api/categories` | Hierarchy |
| `GET`/`POST`/`PATCH` | `/api/suppliers`, `/api/groups`, `/api/fields`, `/api/users` | Configuration |
| `PUT` | `/api/users/:id/access` | Project grants + capabilities |
| `GET` | `/api/duplicates`, `POST /api/duplicates/:id/resolve` | Review queue |
| `GET` | `/api/export` | Excel snapshot (scope-aware) |
| `POST` | `/api/import` | Daily dataset upsert (dry-run supported) |
| `GET` | `/api/audit` | Activity feed scoped by project access |

Errors are JSON: `{ error, errors?, code?, current? }` with `401` unauthenticated,
`403` unauthorised, `404` missing, `409` stale write, `422` validation.

---

## Tests

`npm test` runs both suites against a temporary database:

* `tests/api.test.js` — 17 integration tests covering all twelve required
  scenarios (shared project with six supervisors, multi-project supervisor,
  differing category columns, concurrent edits with conflict detection, CRM
  autosave propagation, duplicate-free updates, creation and validation,
  exports containing fresh data, imports preserving supervisor edits, and
  blocked cross-project access), plus read-only enforcement, admin-only
  endpoints, layout round-trips and concurrent writes.
* `tests/ui.smoke.mjs` — 7 tests that render the views against a minimal DOM shim
  and a stubbed API, catching import errors, render crashes and broken
  autosave/table wiring without needing a browser. Includes an offline test that
  drops the connection mid-save and asserts the panel reports `Not saved`,
  keeps the typed value, and succeeds on explicit retry.

## Project layout

```
server/
  db.js         schema, connection, transactions
  auth.js       password hashing, sessions, capabilities
  audit.js      append-only audit trail
  schema.js     field catalogue, per-category columns, hierarchy
  employees.js  dynamic queries, validation, CRM writes, duplicate detection
  excel.js      workbook generation, import/upsert
  routes.js     HTTP API
  seed.js       demo dataset
  index.js      app bootstrap
public/
  css/styles.css   design system
  js/core.js       DOM helpers, icons, API client, toasts, modals
  js/app.js        shell, navigation, routing
  js/views/*.js    dashboard, workspace, table, crm, datahub, admin, audit, …
tests/             integration + UI smoke tests
start-windows.bat  Windows one-click launcher (checks Node, installs, opens browser)
run-tests.bat      Windows one-click test runner
```
