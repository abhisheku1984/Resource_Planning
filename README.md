# Resource Planning Platform

Single source of truth for the workforce master: one SQLite database, Excel as
import/export only, supervisors update records in the app.

## Quick start (Node 22.5 or newer — nothing else)

> **This is a Node.js application, not a Python one.** No `pip`, no virtualenv,
> no `requirements.txt`. `node:sqlite` is built into Node 22.5+, so nothing is
> compiled and there are no native modules. `package.json` pulls two pure-JS
> packages (Express and ExcelJS).

For a **new checkout** of `main`:

```bash
git clone --branch main https://github.com/abhisheku1984/Resource_Planning.git
cd Resource_Planning
npm ci
npm start         # http://localhost:4000
```

To **update an existing installation on Windows**, stop the running server with
**Ctrl+C**, open PowerShell in the existing `Resource_Planning` folder and run:

```powershell
git fetch origin
git switch main
git pull --ff-only origin main
git log -1 --oneline
npm.cmd ci
.\start-windows.bat
```

Open <http://localhost:4000> and press **Ctrl+Shift+R**. Start in the **same
folder** as before to use the same `data/resource_planning.db`. The server
updates the schema on startup; **do not run `npm run demo` or `npm run seed`
as part of an update**. Those commands replace data. The large demo is optional
and intended only for disposable installations.

### One website link for the team

**[Open the Resource Planning website](https://abhisheku1984.github.io/Resource_Planning/)** for setup instructions and the daily roster workflow. It is a **public guide**, not a sign-in or upload site. GitHub Pages publishes only `docs/` from `main` (**Settings → Pages → Deploy from a branch → main /docs**). Never change the publishing folder to the repository root, `public/` or a data folder.

**Try the app on GitHub, without changing your Windows installation:**

1. Open [GitHub Codespaces setup for this repository](https://github.com/codespaces/new?repo=1465729572&ref=main). Review your account’s quota/billing before creating a codespace. Visiting the public guide does not create one.
2. Select `main`, create your codespace and wait for dependency installation. In its terminal run `npm start` and leave it running.
3. In **Ports**, find **4000**, verify its visibility is **Private**, then choose **Open in Browser**. Use a demo account on that screen. Each fresh codespace has its own synthetic roster; use the [sample workbook](samples/README.md) to test imports.
4. Stop the codespace when finished. Its files are temporary and disappear when it is deleted. Do not upload real staff data, commit a database, or make the demo port public.

For daily work, all supervisors must use the same **approved private app installation**, not individual codespaces. GitHub Pages cannot run the Node API or store shared edits. Before using real data, replace the demo credentials, restrict access, protect the persistent SQLite disk and test private backups; see [Data safety](SECURITY.md).

### Try guided Ask on Windows without using your workforce database

Run **`START-PREVIEW.cmd`** and open **<http://localhost:4110>** when the server is running. By default the preview binds to loopback and uses `data/guided-preview.db`, not the normal `data/resource_planning.db`. If you have activated the workbook preview below, the launcher prints and uses that copy instead. The first start creates synthetic records; no import or reset is needed. Sign in as the demo NEXUS supervisor below and [try a guided update](#try-a-guided-update). Press **Ctrl+C** to stop the preview.

For the 1,000-person test roster, see the [sample workbook and preview walkthrough](samples/README.md). For recurring full dumps, follow the [administrator’s daily export and replacement checklist](samples/DAILY-ROSTER.md). Both upload and export work without Excel or Microsoft 365.

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

Windows: double-click **`start-windows.bat`**. It installs missing app dependencies on first use, starts the server, and opens the browser. Ask is text-only; there is no microphone or speaker setup. Use an **Administrator** login for Administration.

### Employee Directory

The Directory opens directly to **Employee records** and the filters. The table's row count is the number of matching placements across all pages. Clearing filters stays within your authorized projects. The Dashboard shows people and project totals, workforce charts, and quick actions. Use the Audit Trail for change history and Data Hub for duplicate reviews.

### Checking the five filter dropdowns

With the server running in one window, open a second one:

```bash
npm run check:filters
```

It signs in as the administrator, loads the Employee Directory the same way the
browser does, and prints the values plus counts behind **Billing Status, Bench
Category, BL Status, Offsite/Onsite** and **Giga Project Name**. Then it selects
one value in each and confirms the row total becomes exactly the number the
dropdown advertised.
Set `BASE_URL`, `EMAIL` or `PASSWORD` to point it elsewhere.

### Tests

```bash
npm test          # integration + UI smoke tests
```

## Ask: project answers and guided employee updates

Open **Ask** (or **Ctrl+K**). Type or select a **Giga Project Name** from your
workbook. This is not the hierarchy project or its code. If several names are
available and you don't give one, Ask requests a name instead of returning a
database-wide total. Follow-ups keep the selected name until you change it;
permissions and live workbook membership are checked on every request.

| Example (use your actual workbook name and employee ID) | Result |
|---|---|
| `How many are on bench in Giga One?` | Distinct people, plus the bench breakdown for **Giga One only** |
| `How many are hard block?` | Count in the selected Giga project |
| `Who is on bench?` | Up to 25 matching people in that project |
| `Break down billing status` | People by billing status in that project |
| `Set EMP-10001 to hard block` | If the placement matches, a proposal for administrator approval |
| `Open CRM for EMP-10001` | The employee’s scoped CRM form inside Ask |

Counts, lists and breakdowns use live SQLite data, not an AI provider. Unknown
names or unsupported filters do not produce estimates. A person with multiple
matching placements counts once per bucket; distinct buckets can overlap.

After a count, **Show their names** runs a fresh, permission-checked list with
the same filter. Changing project drops that context. **How do approvals work?**
and **How do I import a workbook?** give app instructions, not a database action.

### Try a guided update

Open **Ask → Update an employee** (or **कर्मचारी अपडेट करें**). You can also
start with a goal, without opening a form or memorizing its field keys. Here is
a conversation you can try in the **fresh demo** as Priya. In your workbook,
use an employee ID and Giga Project Name from your own Directory instead.

| You | What happens |
|---|---|
| `Update the interview note for EMP-01031` | Ask requests a workbook project if needed. Select **Giga One**. With more than one matching placement, enter its placement number or click the matching placement chip; it will not guess. |
| `Ready for a client interview` | Ask fills **Detail Comments** on the visible form and shows the employee, placement and **old → new** value. Nothing is saved. |
| `Actually, change that to Interview scheduled for Monday` | The field and review change together. You can also type directly in the field and click **Review changes**. |
| `Yes` / **Confirm save**, or `Cancel` | Only a separate confirmation after the current review writes the update. Cancel discards the draft. |

In Hindi, try **इंटरव्यू नोट अपडेट करें** → choose the workbook project → give
the employee ID → **साक्षात्कार के लिए तैयार** → **नहीं, इसकी जगह सोमवार को साक्षात्कार लिखें**
→ check the revised field → **हाँ** or **रद्द करें**. You can type replies, click suggestions, or edit the visible draft before confirming it.

You can also give several fields in one turn: `For EMP-01031 in Giga One, set
the account owner to Mira and the billing start date to May 12 2027`. An
ambiguous “billing date” prompts for start or end. Put a literal field-like
phrase in quotes (for example `set the note to “Research and account owner to
be discussed”`). This is a local, rules-based guide to the configured fields,
not an open-ended chatbot. **Guide this form** starts it from an already open
Ask CRM with no outstanding edits.

The guide is separate from **Update** autosave. It cannot change employee
identity, a read-only field or the workbook project. For a bench/block status
request use `Set EMP-01031 to hard block` in general Ask: that is a proposal
for **administrator approval**, not a guided save. If the record or access
changes during review, reopen it; the app does not retry the write for you.

### Typing in English and Hindi

In **Ask → Chat language / भाषा**, choose **English** or **हिन्दी**. Type a message and press **Enter** or click **Send message**; **Shift+Enter** adds a new line. Replies and tables appear in the conversation. Switching languages keeps your unsaved CRM values but requires a fresh review before confirmation. Workbook names and IDs are not translated.

| Try this | English | हिन्दी |
|---|---|---|
| Ask about a workbook project | How many are on bench in Giga One? | Giga One में बेंच पर कितने लोग हैं? |
| Ask for a list or breakdown | Who is on bench? / Break down billing status | बेंच पर कौन है? / बिलिंग स्थिति का विवरण दिखाएँ |
| Open an employee’s form | Open CRM | सीआरएम खोलें |
| List editable and read-only field names | List fields | फ़ील्ड बताएं |
| Draft a note | Set Detail Comments to ready for interview | टिप्पणी में साक्षात्कार के लिए तैयार लिखें |
| Check a draft value | Read Detail Comments | टिप्पणी पढ़ें |
| Review the person, project and changes | Review changes | बदलाव की समीक्षा करें |
| Confirm the reviewed draft **or** discard it | Confirm save / Discard changes | सहेजने की पुष्टि करें / बदलाव रद्द करें |
| Close the form | Close CRM | सीआरएम बंद करें |

Use a project in **your** workbook. After “Open CRM”, give the employee ID or
exact full name; if more than one placement matches, enter **placement** /
**प्लेसमेंट** and the offered number. Use the field names on that form. Dates
can be entered as **May 12 2027** or **१२ मई २०२७**. CRM grants, read-only
fields, revision checks and the audited confirmation step apply in both languages.

### The approval step

1. A supervisor asks for a change; it is stored in `agent_actions` as pending.
2. An administrator selects the Giga project and sees its proposals at the top of Ask, old value
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

### The project tree

Projects, subprojects and categories are ordinary records, and categories hang
off subprojects (not projects), so two projects can have completely different
structures and two subprojects of the same project can have different category
sets — see the seeded Nexus vs. Atlas trees. The tree is **read-only in the
UI**: there is deliberately no hierarchy editor, no supplier register and no
employee-group register, because the workbook has no such tabs and a second
place to maintain them is a second place to get out of date. (The API still
accepts hierarchy writes; only the screens were removed.)

### Dynamic tables

As an administrator, open **Administration → Data model** and choose a
**Category**. **New field** adds a definition to the shared catalogue. To use a
new field in this category, check **Visible**, choose its **Editable** and
**Required** settings, then click **Save layout**. Open the same category in
Project Workspace to see the result. Saving these settings keeps the existing
column sequence, filters and supervisor-update settings.

`GET /api/employees?categoryId=…` returns both `rows` and the `columns` that
apply to that category. The client renders whatever it is given, so a category
configured with Training Status + Joining Date + Completion Status looks nothing
like one configured with Billing Status + Allocation Status + Effective Date.
Hidden columns are never serialised, so they cannot leak through the API.

### The Update panel (supervisor CRM)

Clicking a person's **name** opens **Update**: the name, then the 17 workbook
columns **BC–BS** and nothing else — Leader Input Last Week through Demand
Number. There is no Employee ID field (the row identifies the person), no
contact details, no placement, no remarks:

| | | |
|---|---|---|
| Leader Input Last Week | Leader Input This Week | Leader Input PID Account Awaited Name |
| Billing Start Date | Billing Ended Date | PID Awaited Account |
| PID Awaited Blocked Date | Opp ID | Account Owner |
| Allocation Closure ETA | Role of Month | Role of Responses |
| Detail Comments | Hard Block / Soft Block | Account Name |
| Interviewed By | Demand Number | |

**Every change saves itself.** Type, and the field goes *Saving…* → *Saved*;
the value is already in the database, audited with the leader's name and time.
The whole set of changed fields goes in **one transaction**, so a half-typed
screen never lands half-applied. **Save now** is an optional button, not the
only path — there is no "submit then export" step and nothing is held in the
browser:

* the debounce is ~0.9s, and leaving a field saves it immediately;
* a dropped connection keeps the text and retries;
* if someone else saved the same record first, the guard returns `409`, your
  text is kept, the newer revision is loaded and yours is re-saved on top;
* changing person, closing the panel, navigating away or closing the browser
  waits for the in-flight save first (the browser asks before discarding).

`crmKeys` in `server/fielddefs.js` is the single source for that list, and it
drives the panel order and the export order.

### Duplicate prevention

Incoming identity data is matched on employee ID (exact), email, phone and name.
A hard match (ID/email/phone with a *different* employee ID) is queued in
`duplicate_reviews` for an administrator instead of being written silently. Name
matches alone are always queued — never auto-merged.

### Where the data lives

Everything lives in **one SQLite file**: `data/resource_planning.db`. Edits are
written there the moment they are made and are visible to every user straight
away. Nothing is push-synced to Google Drive, OneDrive, Dropbox, email or any
other service, and the app makes **no outbound network calls** — no cloud
account, no API key, no background job. There is no autosave-to-file loop: a
workbook only exists when someone asks for one (below), and it is generated from
the database at that moment.

Excel is therefore **import and export only**: a way in, and a snapshot out. It
is never the store, and two people never share an `.xlsx` to pass changes
around.

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

#### Uploading your own workbook (the 65-column HR file)

Your master file has no **Project / Subproject / Category** column — a
spreadsheet row has nowhere to say which part of the business the person sits
in. So the portal asks once, and files the rows there:

1. Sign in as an importer (`admin`, or a supervisor with `import.data` — the
   demo user is `hr.upload@resourceplanning.io` / `Hr@1234567`).
2. **Data Hub → Import template** downloads `resource-planning-import-template.xlsx`:
   your own 65 headers, in your own order, with `Project, Subproject, Category`
   prepended. A **How to use** sheet and one example row are included — delete
   the example row. (If you would rather keep your file untouched, skip this
   step: any `.xlsx` with your 65 headers is accepted.)
3. **Data Hub → Where should new rows go?** pick the project, subproject and
   category. This is only needed because your file has no placement columns;
   rows that *do* carry Project / Subproject / Category still use their own.
4. Drop the file on **Upload a daily dataset**. A **preview** runs in a
   transaction and is rolled back, so nothing is written: check *New employees*,
   *Updated placements*, *Protected values* and any *Rows needing attention*.
5. Press **Apply import**. The workbook is upserted by **Employee ID**. Rows absent from the file are **not deleted**. For a complete new dump rather than a merge, use **Data Hub → Replace entire roster** as administrator. [Export, replace, verify and recover](samples/DAILY-ROSTER.md).

Header matching is forgiving: case and punctuation are ignored, and the portal
understands the spellings your file actually uses — `unite manual`,
`billing end date`, `PID awaited account + blocked date` and
`Hardblock/Softblock` all land on their own columns. The three headers your
workbook repeats (`account`, `billing status`, `allocation percentage`) are both
kept: the second copy is stored under `… (2nd column)`.

`GET /api/import/template` returns the same blank workbook
(requires `import.data`).

### Rename an account

As an administrator, go to **Administration → Users & access**, click **Edit access** on the account’s row, change **Display name**, and click **Save changes**. This works for supervisors, other administrators, and your own account. A name-only change leaves the login email, password, and permissions untouched. Your own name and initials update immediately; another signed-in user can refresh to see their new name. Past audit entries keep the name recorded at the time.

### Assign or change one Giga project

1. Sign in as an **Administrator**. Open **Administration → Users & access → New user**.
2. Enter the person's name, email and temporary password. Leave **Role** as
   **Supervisor**. In **Giga Project Name**, choose one name from the workbook
   rows already imported into the app. If there are no names, import a workbook
   with this column filled in; there is no separate project list to maintain.
3. A selected project gives read access. Check **Edit employee records** for a
   leader who updates the BC–BS fields. Add CRM, Excel export, employee creation
   or audit permissions only if needed. Click **Create user**. Account and access
   are saved together: an invalid project leaves no partial account behind.
4. To change it later, find that person's row and click **Edit access**. The
   picker shows the current selection. Choose a different Giga project and **Save changes**,
   or choose **No project access** to keep the login and revoke workforce access.
   The change applies on the next request, including in existing sessions. Refresh
   an already open page to reload its navigation and rows; no new sign-in is needed.

**Example:** if XYZ has *Giga North*, XYZ sees only assignments whose **Giga
Project Name** is *Giga North*, even when *Giga South* or blank rows share the
same hierarchy project, subproject and category. A matching assignment in another
placement is still in scope. Clearing Directory filters cannot broaden the grant.
Names are matched exactly after trimming outside whitespace. A rename or removal
of the last matching workbook value gives no rows, **not** access to another Giga.
A supervisor cannot change the Giga name on a row to move it out of scope.

**Upgrading:** existing hierarchy-based accounts keep their grants until you
choose a Giga project (or **No project access**) in their editor. That choice
**replaces**, rather than adds to, their old grants. Administrators retain full
access. Master workbook import and global configuration are not available to
Giga-scoped users. The leader update form is unchanged: no Giga field is added.

**API:** admin-only `GET /api/users` includes `gigaProjectNames` (all distinct,
nonblank live names) and each supervisor's `gigaAccess`. Send `gigaProjectName`
plus `capabilities` with `POST /api/users` or `PUT /api/users/:id/access`.
For example, given an imported name `Giga North`:

```json
{"gigaProjectName":"Giga North","capabilities":{"employee.edit":true,"export.data":false}}
```

Send `{"gigaProjectName":null}` to revoke. The server validates the name and
uses a single grant per user (`user_giga_access`) and a live SQL view over the
existing field (`giga_assignments`); no workforce data is copied. Reads, edits,
counts, CRM, assistant responses, audit and in-app Excel exports are restricted
server-side, before filtering or pagination. New assignments, when permitted,
inherit the user's Giga name.

**Delete** beside a user's name still asks for confirmation. Deletion revokes
sessions, grants and capabilities; employees, edits, import history, approvals,
and past attribution remain. You cannot delete yourself or the last active admin.

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
| `GET` | `/api/dashboard` | The dashboard uses `?summaryOnly=1` for scoped totals and charts, without individual employee or activity lists. The full API response is still available without the parameter. |
| `GET` | `/api/employees` | Dynamic table: scope, search, filter, sort, paginate |
| `GET` | `/api/employees/:id` | One record with its category's columns |
| `PATCH` | `/api/employees/:id` | Validated update with optimistic concurrency |
| `GET` | `/api/employees/:id/history` | Field-level audit history |
| `POST` | `/api/employees` | Create person / link placement (duplicate-aware) |
| `GET` | `/api/people`, `/api/people/:id` | CRM directory search, placements |
| `GET`/`PUT` | `/api/categories/:id/columns` | Read / write the column layout |
| `GET`/`POST`/`PATCH` | `/api/projects`, `/api/subprojects`, `/api/categories` | Hierarchy |
| `GET`/`POST`/`PATCH` | `/api/suppliers`, `/api/groups`, `/api/fields`, `/api/users` | Configuration |
| `PUT` | `/api/users/:id/access` | Rename an account (`name`); optionally update supervisor access and capabilities in the same save |
| `DELETE` | `/api/users/:id` | Remove an account (not yourself, not the last admin) |
| `GET` | `/api/duplicates`, `POST /api/duplicates/:id/resolve` | Review queue |
| `GET` | `/api/export` | Excel snapshot (scope-aware) |
| `POST` | `/api/import` | Daily dataset upsert (dry-run supported, optional `projectId`/`subprojectId`/`categoryId` placement) |
| `POST` | `/api/import/replace` | Admin-only complete replacement: receipt from unfiltered `/api/export?forReplacement=1`, clean dry run of the same file and placement, `confirmation: "REPLACE"`, private restore point, atomic delete + import |
| `GET` | `/api/import/template` | Blank workbook: your 65 headers + the 3 placement columns |
| `GET` | `/api/audit` | Activity feed scoped by project access |
| `GET`, `POST` | `/api/agent/projects`, `/api/agent/ask` | Visible workbook names; local questions, update goals and scoped employee/placement choices |
| `POST` | `/api/agent/crm/:id/review` | Validate `crmProjectName`, numeric `rev`, `before` and `changes`. Returns the normalized field diff and a single-use, five-minute session ticket; no workforce write. `:id` is the placement ID. |
| `POST` | `/api/agent/crm/:id/confirm` | Recheck the same reviewed draft, session ticket, live permissions and revision; use the normal audited update transaction. An expired or superseded ticket requires a new review. |

Errors are JSON: `{ error, errors?, code?, current? }` with `401` unauthenticated,
`403` unauthorised, `404` missing, `409` stale write, `422` validation.

---

## Tests

`npm test` runs the following suites without modifying your application database:

* `tests/api.test.js` — HTTP integration tests against a temporary database, covering all twelve required
  scenarios (shared project with six supervisors, multi-project supervisor,
  differing category columns, concurrent edits with conflict detection, CRM
  autosave propagation, duplicate-free updates, creation and validation,
  exports containing fresh data, imports preserving supervisor edits, and
  blocked cross-project access), plus read-only enforcement, admin-only
  endpoints, layout round-trips, atomic user creation and deletion with work history.
* `tests/ui.smoke.mjs` — tests that render and interact with the views against a minimal DOM shim
  and a stubbed API, catching import errors, render crashes and broken
  autosave/table wiring without needing a browser. Includes an offline test that
  drops the connection mid-save and asserts the panel reports `Not saved`,
  keeps the typed value, and succeeds on explicit retry. Administration tests open
  the user and field forms, confirm/cancel deletion, and submit a category layout.
* `tests/guide.test.mjs` — English/Hindi goal parsing, corrections, multi-field staging and ambiguity. API and UI suites also cover exact placement choices, live permission changes, expired/stale reviews, refusal of unreviewed writes and audit attribution.

**Optional real-browser check:** Run `npm ci --include=dev` and set `CHROME_PATH` to your installed Chrome or Edge executable. `npm run ask:check` verifies the Directory layout and typed English/Hindi conversations against an isolated, in-memory demo database. It does not need browser downloads, audio devices or real HR data.

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
