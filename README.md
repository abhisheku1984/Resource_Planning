# Resource Planning Platform

Single source of truth for the workforce master: one SQLite database, Excel as
import/export only, supervisors update records in the app.

## Quick start (Node 22.5 or newer — nothing else)

> **This is a Node.js application, not a Python one.** No `pip`, no virtualenv,
> no `requirements.txt`. `node:sqlite` is built into Node 22.5+, so nothing is
> compiled and there are no native modules. `package.json` pulls two pure-JS
> packages (Express and ExcelJS).

```bash
git clone https://github.com/abhisheku1984/Resource_Planning.git
cd Resource_Planning
git checkout arena/086f5947-resource-planning
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

### Checking the five filter dropdowns

With the server running in one window, open a second one:

```bash
npm run check:filters
```

It signs in as the administrator, loads the Employee Directory the same way the
browser does, and prints the values plus counts behind **Billing Status, Bench
Category, BL Status, Offsite/Onsite** and **Giga Project Name**. Then it selects
one value in each and confirms the row total becomes exactly the number the
dropdown advertised. Set `BASE_URL`, `EMAIL` or `PASSWORD` to point it elsewhere.

### Tests

```bash
npm test          # 41 integration + UI smoke tests
```

## The assistant (in-app, offline, propose-only)

Press **Ctrl+K** or the **Ask** button in the top bar. It is not a chatbot
connected to a language model — it is a rules-based parser inside this app.

- **It never touches the internet.** No API key, no outbound call. That keeps the
  "zero network traffic" promise in `SECURITY.md` true.
- **It never invents numbers.** Every count is a real SQL query, scoped to the
  projects the asking user may see. Ask about another project and it says it has
  no access instead of quietly answering for a different one.
- **It never writes.** A change request becomes a *proposal* holding the exact
  before/after values. Nothing reaches the master data until an administrator
  clicks **Approve & save**.

| You type | What happens |
|---|---|
| `how many people are on bench in NEXUS?` | Count, plus a breakdown table |
| `how many are hard block in nexus` | Count by block status |
| `who is on bench in NEXUS?` | First 25 matching people |
| `set EMP-10001 to hard block` | A proposal awaiting approval |
| `mark EMP-10001 as bench` | A proposal awaiting approval |

Anything outside those patterns gets "I did not understand that" plus examples —
never a guess.

### The approval step

1. A supervisor asks for a change; it is stored in `agent_actions` as pending.
2. An administrator sees it pinned at the top of the assistant panel, old value
   struck through, new value beside it.
3. If the record still holds the old value, **Approve** writes it and records
   both the approver and the requester in the audit trail.
4. If someone else changed the record meanwhile, approval is refused as `stale`
   rather than overwriting their work.

Excel is unaffected: the database is the record, and the export is generated from
it on demand, always including the approved values.

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

### The Update panel (supervisor CRM)

Clicking a person's **name** (a link in the table) opens **Update**: *Employee
ID*, *Name* and *Placement* as read-only context, then one ordered list of the
18 columns a leader owns — **Leader Input Last Week** through **Giga Project
Name**, per the workbook. Not the whole 68-field record, and not the contact or
identity fields: a leader sees only what they are meant to fill in. Fill anything, press **Submit**, and the fields are written in a single
transaction, audited with the supervisor's name.

The column list is a setting (`crm_fields`), editable in
*Administration → CRM panel*: add, remove and reorder without a code change.
Submit needs no Excel round trip — see *Excel synchronisation* for how the next
export shows the change.

The separate CRM panel stays for people management (contact details, new
joiners, placements and per-field history). It autosaves with a 900 ms debounce
and reports `Unsaved → Saving… → Saved`; on failure it shows `Not saved` with an
explicit retry, and the pending values stay in the form.

### Duplicate prevention

Incoming identity data is matched on employee ID (exact), email, phone and name.
A hard match (ID/email/phone with a *different* employee ID) is queued in
`duplicate_reviews` for an administrator instead of being written silently. Name
matches alone are always queued — never auto-merged.

### Excel synchronisation

* `GET /api/export?projectId=&subprojectId=&categoryId=&supplierId=` streams a
  workbook with `Employees` and `Summary` sheets built from the live database.
  The supervisor columns come first, in the same order the Update panel shows
  them; beside each one the report adds **`<column> — Updated By`** and
  **`<column> — Updated At`**, plus a single **Last Supervisor Update** line, so
  an administrator can see who changed what and when without asking. The
  importer recognises and skips those derived columns, so the report can be
  re-uploaded safely.
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
