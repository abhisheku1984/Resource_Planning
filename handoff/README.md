# Resource Planning — parallel build README

> **Historical handoff for `c8a76f3`.** The current app has text-only Ask and no summary cards in Employee Directory. For the current build and Windows startup instructions, use the [project README](../README.md).

**What to build:** a local workforce planning app for the team that receives the daily HR master workbook and the supervisors who update it. HR imports the file once. A supervisor signs in, sees the people they are responsible for, and updates a placement. An administrator downloads a fresh Excel report showing the value, who changed it, and when. Nobody has to pass an edited workbook to the next person.

**Scope:** this describes the working Resource Planning baseline at `c8a76f3`. It is not a specification for an NGO, clinic, generic chatbot, or a public SaaS. The section marked **Future only** is not part of baseline acceptance. All examples here are synthetic. These two Markdown files are enough to start a separate build: give this README to the builder with the prompt in `admin.md`. No access to the original repository, staff records, passwords, or workbooks is required.

## 1. How it runs

- **Runtime:** Node.js (reference minimum 22.5; use a current Node 22 LTS patch or compatible later version), Express 4, built-in `node:sqlite`, ExcelJS 4. Browser UI: plain JavaScript ES modules, HTML, CSS, locally served fonts. No Python, compiler, frontend bundler, cloud account or AI API key required for the base app.
- **Store:** `data/resource_planning.db`, including its SQLite WAL files while open. SQLite is the source of truth. Excel is an input or a point-in-time export, never a live store. Enable foreign keys, WAL and a busy timeout; use transactions and parameterized queries. Use additive, repeatable schema upgrades. Seed a small synthetic demo only on first use of an empty database.
- **Launch:** from the new app folder, `npm ci` then `npm start`; open `http://localhost:4000`. Include `start-windows.bat` for one-click startup and `run-tests.bat` / `npm test` for isolated tests. Windows startup checks Node, prepares missing dependencies/voice files, then opens the app. Plain `npm start` does not install speech. Normal updates must **never** run `npm run seed` or `npm run demo`: those are destructive, disposable-demo tools, not migrations.
- **Running in parallel:** use a different folder **and database**. If the original occupies port 4000, in PowerShell in the new folder run `$env:PORT='4100'; npm.cmd start` and open `http://localhost:4100`. Don't point `DB_FILE` at the original; use a temporary file or `:memory:` for tests. Back up a stopped database before updating it.
- **Privacy boundary:** loopback (`127.0.0.1`) by default; LAN binding only by explicit choice. UI and API use the same origin and relative URLs. No runtime outbound model calls, telemetry, CDNs, external fonts, audio uploads, or workbook sync. Initial package and optional speech setup downloads are separate from processing HR data. Local HTTP and unencrypted SQLite are not a production Internet deployment. Keep employee data outside synced folders; use separate non-demo credentials and disk/backup protection for real use.

## 2. The data model: three distinctions that affect every screen

| Distinction | Required behavior |
|---|---|
| **Person vs. placement** | `employees` owns a unique **Employee ID** (`emp_code`, text; preserve leading zeros), names and contact details. An `assignment` is one placement, unique by `(employee_id, subproject_id, category_id)`, with hierarchy project, optional supplier, status, remarks and an integer `rev`. One employee can occupy several placements. Row-level actions take an **assignment ID**, not an employee code or a name. |
| **Hierarchy project vs. Giga Project Name** | Navigation follows **Project → Subproject → Category → placements**. `giga_project_name` is a *workbook field on each placement*. A single Giga name can cross branches, and the same hierarchy category can contain several Giga names or blanks. Do not build a second Giga registry or infer the value from a hierarchy code. |
| **Field definition vs. field value** | `fields` defines stable keys, user-facing labels, type and select options. `category_fields` defines order, visibility, editability, required, filter and update settings. `assignment_values` stores additional fields by `(assignment_id, field_id)` with source and attribution. Adding a field does not add a database column. The `settings` table stores the ordered supervisor panel keys under `crm_fields`. |

Keep separate tables for users, sessions, grants, capabilities, field overrides, duplicate reviews, import history, assistant proposals (`agent_actions`) and field-level `audit_log`. Index the business key, placement joins, assignment/field pairs, and scope/filter paths. Derive a live `giga_assignments` relation from active placements/people with a trimmed, nonblank workbook name; do not copy workforces into one table per supervisor.

## 3. Roles and the administrator's workflow

There are two account roles: **administrator** and **supervisor**. A read-only reviewer and an HR uploader are different *grants on supervisor accounts*, not additional superuser roles.

1. **Set up the data.** An admin or an authorized hierarchy-based importer loads a workbook in Data Hub. The live, distinct workbook Giga names become available in **Administration → Users & access**.
2. **Create a supervisor.** Give name, email, temporary password, role, and one Giga Project Name. Selection grants read access. Add only needed capabilities: `employee.edit`, `employee.create`, `crm.use`, `export.data`, `audit.view`. Create the account and grants in one transaction; an invalid grant must leave no half-created account. A reviewer has no write grant.
3. **Enforce the grant on the server.** Match the exact trimmed Giga name, not a prefix or wildcard. Apply the authorized assignment set *before* search, pagination, totals, dropdown counts, charts, person lookup, history, Ask or export. Optional filters only narrow this set. A supervisor cannot move a record into or out of their grant by editing its Giga name, or edit a shared identity through a hidden placement. Permitted new placements inherit their scope.
4. **Edit or revoke.** Older hierarchy-based users can have several project grants, each with edit/CRM/export flags; six supervisors may share one project. Choosing one Giga grant **replaces**, not adds to, legacy hierarchy grants. “No project access” keeps the login but grants no rows. Revocation, a changed workbook name, or a deleted account takes effect on subsequent requests, including existing sessions. Giga accounts cannot import the global master or administer configuration.
5. **Manage the UI.** Administration has **Data model**, **CRM panel**, **Users & access**. Manage field definitions and per-category layouts; configure the CRM column order centrally, not per form. Watch pending duplicates in Data Hub and change proposals in Ask. Account deletion must be confirmed, cannot target yourself or the last active admin, and removes sessions/grants without erasing workforce records, edit attribution or audit history. The hierarchy tree is navigable but read-only in the UI; no separate supplier, group or hierarchy maintenance screens are required.

Use salted `scrypt` password hashes and random expiring server-side sessions (reference: seven-day bearer tokens); logout revokes the token and changing a password revokes the user's sessions. Recheck capabilities and data scope on every authenticated request. Hiding a button is not authorization.

## 4. Screens and daily workflows

| Screen | What the user does and what must be true |
|---|---|
| **Dashboard** | Sees authorized people vs. placements, hierarchy project/supplier counts, workforce status, project and supplier mix, attention items and permitted recent activity. Clicking a project leads into its workspace. No global counts for restricted users. |
| **Project Workspace** | Drills through the tree to a category. The employee table renders the category's columns from the API, not from a fixed spreadsheet layout. Search, sort, paginate, edit allowed cells, open an employee or add a permitted person/placement. Retain navigation context. |
| **Employee Directory** | Searches across all authorized placements. The five primary dropdowns are **Billing Status, Bench Category, BL Status, Offsite / Onsite, Giga Project Name**, in that order; other dimensions are secondary. List real distinct values and counts. When counting a dropdown's alternatives, retain authorization and the other filters but omit its own selection. Selecting the advertised value must yield the advertised number of rows. |
| **Directory totals** | Use the same filtered relation as the rows, **before** pagination: distinct people, placements, distinct nonblank Giga names, distinct hierarchy projects, and pending duplicate reviews (admin only, once per review). Clearing a filter must not clear access. On load/failure don't show stale counts as current. |
| **Supervisor Update / embedded CRM** | Clicking a person's name identifies the placement and opens its update form. Show the employee's name and identifying context; by default the editable form consists of the 17 fields in Appendix B, not contact info, Employee ID, Giga name or remarks. The ordinary panel autosaves valid changed fields after about 900 ms or on blur, or via **Save now**. Show Saving / Saved / Not saved from server results. Retain unsaved text on a connection failure; handle leaving or changing records without silently losing it. Authorized users can also search people and inspect their permitted placements. |
| **Data Hub** | Download a template; choose a default placement, preview a daily `.xlsx`, inspect results, then apply. Generate a consolidated or filtered authorized export (project, subproject, category or supplier). Show import history and the admin-only duplicate review queue where permitted. |
| **Audit Trail** | Shows old value → new value, field, actor, time and record reference, within access. Record imports, exports, user/config changes and assistant decisions as well as workforce edits. Historical attribution must survive account deletion. |

Use a compact desktop workspace: dark left rail, breadcrumbs, white panels, blue primary actions, legible dense tables, sticky headers, right-side editor and responsive stacking/overlay. Use locally served Latin and Devanagari fonts. Label controls, support keyboard focus and Enter/Escape for inline edits, show loading/empty/error states, and make save status readable without relying on color alone.

## 5. The three write paths — do not merge these behaviors

| How the change starts | What happens before the workforce record changes |
|---|---|
| **User edits the ordinary table or Update panel** | Authorized inline edits save directly; the panel batches its changed valid fields in one transaction. Send the current assignment revision. A stale edit returns `409 STALE`; the normal editor can retain local text and refresh/retry against the current record. Never display “Saved” for a failed write. |
| **User explicitly opens CRM inside Ask** | “Open CRM” → select the employee by ID or exact full name in the selected Giga project → if needed choose the offered placement ID. “Set Detail Comments to ready for interview” updates the **visible input and an in-memory draft**, not SQLite. Support list/read/set/clear fields, review, confirm save, discard, and close. Review identifies the employee, project and proposed values. Changing a field or language invalidates the review. **Only separate confirmation** posts the reviewed changes. Recheck placement, project, field allowlist, edit/CRM rights, types and revision on the server. On a stale or revoked record, don't auto-retry a confirmed draft. |
| **User requests a change in general Ask chat** | “Set EMP-00001 to hard block” is a supported change request for the bench/block fields, **not permission to save directly**. Resolve one authorized assignment; stage before/after values and workbook project as a pending proposal. Only an admin approves or rejects it. Reject makes no workforce change; if the field or project changed, mark it stale. Audit the requester and decision maker. Saying “yes” in chat does not confer admin rights. |

For committed field edits record old/new value, actor and time; protect manually edited supervisor values from an ordinary later import. The next table read and Excel export should reflect the committed value. Typing into the Ask draft must **not** trigger the ordinary editor's autosave handler.

## 6. Workbook contract

- Accept the 65 raw HR headers listed in Appendix A, or a workbook with **Project, Subproject, Category** prepended. Prefer the `Employees` worksheet, otherwise use the first. Provide a downloadable template with both `Employees` and `How to use`, and one clearly removable example row. A raw HR file has no hierarchy columns: take them from the row when supplied, else from the chosen default placement (or an unambiguous single placement); otherwise report the missing placement. Do not file rows just by guessing their Giga name.
- Normalize case, punctuation and spaces for matching. Preserve the two occurrences of each of **account**, **billing status**, **allocation percentage** as separate fields; ignore empty header 43. The spelling `unite manual` is intentional. `PID awaited account + blocked date` maps to the **account text**; `PID Awaited Blocked Date` is its own date field if supplied separately. The 65-column input and the 17-field supervisor panel are two distinct lists; **do not take a positional slice** of the raw input to build the panel.
- Match by Employee ID, then upsert the placement. Repeating the same workbook must not duplicate identities/placements. Conflicting email/phone or similar names are duplicate-review signals, not authority to merge two IDs. Missing ID, bad placement, invalid date/number/select or other row issues need useful messages. Never silently substitute a different employee.
- **Preview** runs the actual import logic in a transaction and rolls it back, including audit/review side effects. Report created, updated, protected, flagged, and row-numbered problems. **Apply** is explicit and transactional; distinguish accepted data from reported errors. Protected supervisor values stay unchanged on normal import. A forced overwrite must be a separate, explicitly authorized and audited operation in the new build.
- **Export** real `.xlsx`: `README` (scope, generator, time), `Employees` (one row per authorized matching placement), `Summary` (counts by hierarchy project/subproject/category). Put configured CRM values in their panel order after identity/placement metadata. Include `<field> — Updated By`, `<field> — Updated At`, and `Last Supervisor Update`. Ignore these derived stamps on re-import. Use batched reads so large exports do not lose values after the first page.

## 7. Ask and offline speech

**Text comes first.** Open **Ask** or press Ctrl/Cmd+K. Choose **English** or **हिन्दी** and a visible workbook Giga name. Reuse that name on follow-ups, but recheck it for each request. With several choices, ask which one; an unknown, ambiguous or revoked name must never fall back to a global count. Use deterministic intents + scoped SQL, not an LLM. Return a written answer, appropriate table and next actions. Count distinct people (one person can appear in different breakdown buckets), list up to 25 names/IDs, or break down bench, billing, block, BL or offsite status. Unsupported filters get a clarification/help response, not a plausible number.

| English example | Hindi example | Expected result |
|---|---|---|
| How many are on bench in Giga North? | Giga North में बेंच पर कितने लोग हैं? | Count only matching authorized people in that workbook project. |
| Open CRM | सीआरएम खोलें | Ask which employee; disambiguate placements rather than editing the first one. |
| Set Detail Comments to ready for interview | टिप्पणी में साक्षात्कार के लिए तैयार लिखें | Draft the note visibly; no workforce write. |
| Review changes → Confirm save | बदलाव की समीक्षा करें → सहेजने की पुष्टि करें | Two separate actions; save only the still-current reviewed draft. |

Keep actual workbook names, IDs and dates exact in the data. Hindi labels, spoken numbers and date forms are presentation/input handling, not a translation of the stored identifiers. Language choice applies to Ask, not the entire site.

**Mic input, transcript interpretation, and spoken output are three different things.**

- Start voice only on a user gesture in a secure context (localhost/HTTPS) with permission. Prefer the installed Vosk Indian-English/Hindi browser packs. A native recognizer is acceptable only with proven on-device processing (`processLocally`), never a silent cloud fallback. Show interim words locally; dispatch only the final transcript, once, through the **same command handler as typing**. Audio never leaves the browser.
- Release the mic during command handling and spoken replies; resume for the next turn only if voice is still on. Stop, close, hidden tab, sign-out and language switch cancel capture/playback and invalidate late callbacks. Test speaker / Read last reply must never request the mic. Keep typing usable with no devices or packs. Distinguish missing models, permission denial, insecure page, no device, silence and playback errors; keep the reason visible on reopening Ask.
- Output choices: **Auto** (installed Studio → Standard → matching local device voice), **Studio** (Ninada Indian English/Hindi via local ONNX/WASM), **Standard** (CMU Flite Indian English/Hindi via WASM), **Local device** (matching `localService` voice only). An explicit missing engine reports why; don't silently speak Hindi using an English voice. Offer Stop and volume up to 200% for the local engines, with peak limiting. Studio is speaker-only; it does not install or fix a microphone.
- Windows preflight (`voice:prepare`) checks both languages, reuses valid files/Studio voices, downloads missing mic or needed Standard assets once. A warm launch requires no voice downloads. `--no-voice` skips setup; if setup fails, start the typed app anyway. Keep operator commands `voice:setup` and `voice:studio` separate; no installation endpoint. `/speech/status` distinguishes `input`, `output` (Standard) and `studio` by language. Use read-only allowlisted same-origin assets and workers. Keep the main page's CSP strict. Do not persist audio/transcript history in browser storage; saved CRM values and audited requests are normal business records.

**Future only — not a claim about the baseline:** the NGO example suggested a more guided conversation: “Update the interview note for EMP-00001” → resolve project/placement → “What should the note say?” → fill Detail Comments → accept “actually, change that to …” → show revised draft → explicit save. This requires new intent and follow-up handling. Do **not** implement it in a baseline reproduction unless the owner requests it separately. Do not copy NGO modules, Python services, donor roles or a cloud speech provider.

## 8. Integration guide

All routes below are under `/api` except `/speech`. Use bearer auth for protected API calls. Error responses distinguish unauthenticated (`401`), forbidden (`403`), missing (`404`), conflict (`409`, with current permitted state where appropriate), and invalid input (`422`, with field/row messages).

| Operations | Contract to preserve |
|---|---|
| Session / shell | `POST /auth/login`, `POST /auth/logout`, `POST /auth/password`, `GET /auth/me`, `GET /bootstrap`, `GET /dashboard`, `GET /health`. Bootstrap supplies user/grants, visible tree, field catalogue, CRM keys and scoped totals. |
| Workforce | `GET /employees` accepts project/subproject/category/supplier IDs, search, `f_<fieldKey>`, sort, page and pageSize. Returns `rows`, `columns`, `facets`, `total` and page metadata; `includeSummary=1` adds Directory totals. Also `GET /employees/facets`. `GET/PATCH /employees/:id`, `GET /employees/:id/history`, `POST /employees`, `GET /people`, `GET /people/:id`. For employee **row** endpoints, `:id` identifies the assignment; a person lookup identifies a person. |
| Update | `POST /employees/:id/submit` with `changes`, `rev`, `reason`; Ask CRM also sends `crmProjectName`. Return committed `record` and `changed` keys. Field definitions/types and authorization come from the server, not a client label. |
| Ask | `GET /agent/projects`; `POST /agent/ask` with `{message, projectName, language}` returns `reply`, `kind`, `understood`, `projectName`, optional `table`, `data`, `crm`, `proposal`, `suggestions`. `GET /agent/proposals` plus admin `POST /agent/proposals/:id/approve` or `/reject`. Not an arbitrary SQL or generic write endpoint. |
| Excel / review / audit | `GET /import/template`, `POST /import` (filename, base64 workbook content, dryRun, default placement IDs), `GET /imports`, `GET /export`, `GET /duplicates`, `POST /duplicates/:id/resolve`, `GET /audit`. Use the same scoping logic as the employee list for exports, plus export permission. |
| Configuration | `GET/POST /fields`, `PATCH /fields/:id`, `GET/PUT /categories/:id/columns`, `GET/PUT /settings/crm-fields`, `GET/POST /users`, `PUT /users/:id/access`, `DELETE /users/:id`. Validate account + grants atomically. Retain hierarchy/supplier/group reference data even though they have no dedicated maintenance screens. |

If a reference checkout is available, the implementation anchors are `server/{db,access,auth,fielddefs,schema,query,employees,excel,routes,agent,agentstore,assistant-crm}.js`, `public/js/views/{submit,crm,assistant,assistant-crm,admin}.js`, `public/js/voice.js`, `public/js/speech/` and `voice/`. Acceptance evidence lives under `tests/` and `voice/check-browser.mjs`. A green unit test is not proof that a physical microphone worked.

## 9. Small acceptance workbook (invented for the parallel build)

Use a fresh test DB. Create the following **four placements** with three synthetic identities; give each ID a synthetic first/last name. Assign a supervisor to `Giga North` with edit/CRM/export. Also create a read-only user, a hierarchy-based HR importer, and an administrator. These are test fixtures, not real employees or a claim about the shipped seed.

| Employee ID | Project / Subproject / Category | Giga Project Name | Bench Category | Billing Status |
|---|---|---|---|---|
| EMP-00001 | Alpha / Build / Delivery | Giga North | Bench | Non-Billable |
| EMP-00001 | Beta / Run / Support | Giga North | Allocated | Billable |
| EMP-00002 | Alpha / Build / Delivery | Giga South | Bench | Non-Billable |
| EMP-00003 | Alpha / Build / Delivery | *(empty cell)* | Bench | Non-Billable |

| Check | Observable pass condition |
|---|---|
| **A. Counts and grants** | Unfiltered admin: **3 people, 4 placements, 2 named Gigas, 2 hierarchy projects**. North supervisor: **1 person, 2 placements, 1 Giga, 2 hierarchy projects**. Selecting Bench gives this supervisor **1 placement**. Changing page size doesn't alter totals. Clearing filters doesn't reveal South or the blank row. Direct reads, exports, audit and Ask cannot reveal hidden siblings. Replacing/revoking a grant takes effect without signing in again. |
| **B. Data Hub round trip** | Template has three placement headers + the exact 65 below. Load a raw workbook with distinct values in the repeated headers. Preview changes nothing; Apply + repeat does not duplicate rows. Manually edit a note, then re-import a different note: the protected value survives. Export shows the saved note, editor and time; re-import does not create stamp fields. Flag uncertain duplicates instead of merging by name. |
| **C. Ordinary edits and admin** | Change two Update fields, wait for Saved, reload/restart: both persist and have audit entries. A failed save is not labeled Saved; a stale `rev` is refused. A new category-specific column appears only where configured; its layout survives restart. Invalid user creation leaves no partial login. Deleting an eligible demo user revokes sessions, not edit history. |
| **D. Ask writes** | In English **and** Hindi, ask for people on bench in North: **1**. Ask to open CRM for EMP-00001: choose between the two permitted placements. The visible field changes after dictation/typing, while a separate API read still shows the old value. Review, correct the draft, verify old confirmation is invalid, review again and confirm: one authorized save. Discard saves nothing. A separate hard-block chat request is pending until admin approval; reject or stale approval must not change the record. |
| **E. Voice** | With packs absent and mic denied, typed Ask still works. In each language with local packs, press **Start voice before Test speaker**; recognize a known phrase, get the correct scoped reply, release input during playback, resume afterward, stop with no live tracks. Test speaker alone makes zero mic requests. Report separately what passed in unit tests, file-backed Chromium and on a physical Windows mic; mark anything not tested. |
| **F. Independent install** | Cold install in a new directory, warm restart offline, and an update preserve the independent DB. The base suite runs with no browser models or production data. A separate synthetic load test at about 12,000 placements checks that counts and export rows/values are not truncated at a page or SQL batch boundary. |

The appendices below are data contracts for the builder, not additional files the owner needs to upload.

## Appendix A. Exact HR import map

First row in the raw workbook: use the **header** values below, in order (not the numbers, keys, or types). Keep empty slot 43 empty. The template adds the three hierarchy columns *before* these. The key and type columns are for the implementation. Keep identifiers as text, normalize valid dates to `YYYY-MM-DD`, and validate typed edits against the configured field options.

| # | Raw header | Field key | Type |
|---:|---|---|---|
| 1 | `capability` | `capability` | select |
| 2 | `employee ID` | `emp_code` | text |
| 3 | `first name` | `first_name` | text |
| 4 | `last name` | `last_name` | text |
| 5 | `revised allocation` | `revised_allocation` | number |
| 6 | `build status` | `build_status` | select |
| 7 | `job profile family` | `job_profile_family` | text |
| 8 | `management level` | `management_level` | select |
| 9 | `DOJ` | `doj` | date |
| 10 | `country` | `country` | select |
| 11 | `manager ID` | `manager_id` | text |
| 12 | `manager name` | `manager_name` | text |
| 13 | `cost center ID` | `cost_center_id` | text |
| 14 | `cost center name` | `cost_center_name` | text |
| 15 | `PMI project name` | `pmi_project_name` | text |
| 16 | `project ID` | `project_id_ext` | text |
| 17 | `allocation start date` | `allocation_start_date` | date |
| 18 | `allocation ended date` | `allocation_end_date` | date |
| 19 | `last week end date` | `last_week_end_date` | date |
| 20 | `allocation percentage` | `allocation_percentage` | number |
| 21 | `account` | `account` | text |
| 22 | `vertical` | `vertical` | text |
| 23 | `status` | `status` | select |
| 24 | `service status` | `service_status` | select |
| 25 | `source` | `source` | select |
| 26 | `account manual` | `account_manual` | text |
| 27 | `bench aging` | `bench_aging` | number |
| 28 | `bench aging comment` | `bench_aging_comment` | textarea |
| 29 | `bench aging category` | `bench_aging_category` | select |
| 30 | `BL status` | `bl_status` | text |
| 31 | `bench later issue date` | `bench_later_issue_date` | date |
| 32 | `bench later end date` | `bench_later_end_date` | date |
| 33 | `offsite/onsite` | `offsite_onsite` | select |
| 34 | `vertical manual` | `vertical_manual` | text |
| 35 | `unite manual` | `unit_manual` | text |
| 36 | `AE` | `ae` | text |
| 37 | `VP mapping` | `vp_mapping` | text |
| 38 | `billing status` | `billing_status` | select |
| 39 | `bench category` | `bench_category` | select |
| 40 | `bench subcategory` | `bench_subcategory` | text |
| 41 | `account` | `account_secondary` | text |
| 42 | `remarks` | `remarks` | textarea |
| 43 | *(empty)* | — | ignore |
| 44 | `PID aging in weeks` | `pid_aging_weeks` | number |
| 45 | `PID segment` | `pid_segment` | text |
| 46 | `leader input last week` | `leader_input_last_week` | textarea |
| 47 | `leader input this week` | `leader_input_this_week` | textarea |
| 48 | `leader input PID account awaited name` | `leader_input_pid_account` | text |
| 49 | `billing status` | `billing_status_secondary` | select |
| 50 | `billing start date` | `billing_start_date` | date |
| 51 | `billing end date` | `billing_end_date` | date |
| 52 | `PID awaited account + blocked date` | `pid_awaited_account` | text |
| 53 | `Opp ID` | `opp_id` | text |
| 54 | `allocation percentage` | `allocation_percentage_secondary` | number |
| 55 | `account owner` | `account_owner` | text |
| 56 | `allocation closure ETA` | `allocation_closure_eta` | date |
| 57 | `role of month` | `role_of_month` | text |
| 58 | `role of responses` | `role_of_responses` | textarea |
| 59 | `detail comments` | `detail_comments` | textarea |
| 60 | `Hardblock/Softblock` | `block_status` | select |
| 61 | `account name` | `account_name` | text |
| 62 | `interviewed by` | `interviewed_by` | text |
| 63 | `demand number` | `demand_number` | text |
| 64 | `giga project name` | `giga_project_name` | text |
| 65 | `ARD date` | `ard_date` | date |

**Initial select values** (new category layouts may reuse the same field definition):

| Key | Options |
|---|---|
| `capability` | Data · Advisory · Tech · Support |
| `build_status` | Billed · Partially Billed · Unbilled · Not Available |
| `management_level` | 1 · 2 · 3 · 4A · 4B · 4C · 4D · 5A · 5B |
| `country` | India · United States · United Kingdom · Singapore · UAE · Germany |
| `status` | Allocated · Leadership · Not Available · Unbilled |
| `service_status` | Located · Growth Training Development · Internal Project · Maternity · Operation Challenge · Project Role · IT Deployment · RGFTE · Supervise · Support |
| `source` | As per RAR · As per System |
| `bench_aging_category` | 0-30 days · 31-60 days · 61-90 days · 90+ days |
| `offsite_onsite` | Offsite · Onsite · Offsite-Onsite |
| `billing_status` | Billable · Non-Billable · Shadow · T&M · Fixed Price |
| `bench_category` | Allocated · PID Allocated · Bench · Available · Not Available · Shadow · Partially Allocated · Rolling Off · Onboarding |
| `block_status` | No Block · Soft Block · Hard Block |
| `billing_status_secondary` | Billable · Non-Billable · Shadow · T&M · Fixed Price |

Supplier choices come from the authorized supplier records, not a hard-coded list. Contact email and phone are additional identity fields; they are not required extra headers in the raw 65-column master.

## Appendix B. Default supervisor fields (BC–BS)

Use this ordered list for the Update panel; reuse it for Ask CRM subject to editability and for CRM ordering in reports. IDs/context may appear in the header, not as extra editable fields. Keep **Detail Comments** distinct from the general **Remarks** field.

| Order | Workbook reference | UI label | Field key | Type |
|---:|---|---|---|---|
| 1 | BC | Leader Input Last Week | `leader_input_last_week` | textarea |
| 2 | BD | Leader Input This Week | `leader_input_this_week` | textarea |
| 3 | BE | Leader Input PID Account Awaited Name | `leader_input_pid_account` | text |
| 4 | BF | Billing Start Date | `billing_start_date` | date |
| 5 | BG | Billing Ended Date | `billing_end_date` | date |
| 6 | BH | PID Awaited Account | `pid_awaited_account` | text |
| 7 | BI | PID Awaited Blocked Date | `pid_awaited_blocked_date` | date |
| 8 | BJ | Opp ID | `opp_id` | text |
| 9 | BK | Account Owner | `account_owner` | text |
| 10 | BL | Allocation Closure ETA | `allocation_closure_eta` | date |
| 11 | BM | Role of Month | `role_of_month` | text |
| 12 | BN | Role of Responses | `role_of_responses` | textarea |
| 13 | BO | Detail Comments | `detail_comments` | textarea |
| 14 | BP | Hard Block / Soft Block | `block_status` | select |
| 15 | BQ | Account Name | `account_name` | text |
| 16 | BR | Interviewed By | `interviewed_by` | text |
| 17 | BS | Demand Number | `demand_number` | text |

## Appendix C. Reproducing the offline voices

These are the reference pins, not runtime web URLs to put into the UI. The installer downloads to a temporary file, verifies size and SHA-256, then publishes locally. For Git blob API URLs request raw bytes, not the JSON/base64 envelope. Do not alter archive structure or rename a ZIP as a TAR. Preserve upstream licensing, notices and voice/dataset attribution; check redistribution terms before shipping model weights. The documents contain no model files.

- **Recognition:** `@lichess-org/vosk-browser@0.0.3` in a worker, with separate Vosk en-IN and Hindi browser model archives.
- **Standard output:** `@echogarden/flite-wasi@0.1.1`, `@bjorn3/browser_wasi_shim@0.4.2` and the CMU KSP / Indic Hindi AB voices.
- **Studio output:** `ninada@5.1.2` tokenizer, separate native-language ONNX models and `onnxruntime-web@1.31.1` in a single-thread WASM speaker worker; 24 kHz mono. This install does not provide input models.
- Keep these runtimes out of the base app dependencies. Use separate locked installs with lifecycle scripts disabled. Only the necessary worker gets the permission to compile its local engine; the main page does not get an eval exception.

| Language / use | File (pinned source) | Bytes | SHA-256 |
|---|---|---:|---|
| en / input | [vosk-small-en-in-0.4.tar.gz](https://api.github.com/repos/ccoreilly/vosk-browser/git/blobs/7c9709ee5e5b45faf6c715573b9ff0fe9e1b29f3) | 37561269 | `9baa24e2049fba77164fdf01a538b59d49102efbf980d240431b8c4a91f1cc8d` |
| en / output | [cmu-us-ksp-2014.flitevox](https://api.github.com/repos/associationconsonne/FliteVoices/git/blobs/04d66ccd0a486149ae4d928fc138182d2fcfbbb4) | 24954163 | `5a9ee932cff8d16ef883186f4dab7fc167fb5763bbf7a040b9eee1f741b2aecb` |
| hi / input | [vosk-small-hi-0.22.tar.gz](https://codeload.github.com/factfilter0-coder/vosk-model-hindi/tar.gz/4431efa5f66d086e3aec5c2634f988e2b55d147d) | 44458327 | `8fc5da89de127a47bd0a8c2a7a73eea561519e8cd07fc3381af95fda29102371` |
| hi / output | [cmu-indic-hin-ab-2017.flitevox](https://api.github.com/repos/associationconsonne/FliteVoices/git/blobs/4963a08c77502c5ae5cb6e4b3a04ba98c449d00f) | 30897320 | `4be49f3da1c46c32f155d74974c73bcf10ffd91ec508c74210274fc074cf60ad` |
| en / studio | [ninada-5.1.2-en-IN.onnx](https://api.github.com/repos/hemanth/ninada/git/blobs/2755df1c39aec3981d47e1f2d1114801afa62740) | 29280152 | `ee8840fe000fed659ddf916f8a070f42b07a6a6c234e5d13209d53c025a95652` |
| hi / studio | [ninada-5.1.2-hi-IN.onnx](https://api.github.com/repos/hemanth/ninada/git/blobs/cb77f6883bc203c0473e383ca10f3dbad5db4b49) | 29283680 | `c4caca31b52c26989a847767b212109b3a8c9aa56ebb8ab78198f8d893378867` |

Browser QA should start from a cold mic in each language with native speech disabled, using an isolated server/DB and file-backed audio. Record the actual recognized words, answer, and track release/resume/Stop. Separately, on the intended Windows PC, use the real microphone and speakers. If the latter has not been done, say **physical-device test not performed**.
